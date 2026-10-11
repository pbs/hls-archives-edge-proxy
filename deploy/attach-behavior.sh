#!/usr/bin/env bash
# Add one cache behavior, *.arch.*, to an existing CloudFront distribution and associate the
# function with it as an origin-request trigger. Origin, viewer protocol policy, response
# headers policy (CORS) and trusted signers are copied from the behavior that serves *.m3u8
# today, or from the default behavior. The new behavior is inserted first so it wins over
# *.m3u8. Nothing else in the distribution changes.
#
#   deploy/attach-behavior.sh <distribution-id> <lambda-version-arn>
set -euo pipefail

if [ $# -ne 2 ]; then echo "usage: $0 <distribution-id> <lambda-version-arn>" >&2; exit 2; fi
DIST="$1"; LAMBDA_ARN="$2"
CACHING_OPTIMIZED="658327ea-f89d-4fab-a63d-7e88639e58f6"   # AWS managed cache policy: no query strings, compression on, honors origin Cache-Control
SIMPLE_CORS="60669652-455b-4ae9-85a4-c4c02393f86c"         # AWS managed response headers policy: Access-Control-Allow-Origin: *
# Generated responses never pass through the origin, so CORS headers the origin would have
# added (MediaPackage v1 reflects the Origin header) don't exist here. If the *.m3u8 behavior
# has no response headers policy of its own, the new behavior gets SimpleCORS.

TMP="$(mktemp -d)"
aws cloudfront get-distribution-config --id "$DIST" > "$TMP/dist.json"
ETAG=$(jq -r .ETag "$TMP/dist.json")

jq --arg arn "$LAMBDA_ARN" --arg policy "$CACHING_OPTIMIZED" --arg cors "$SIMPLE_CORS" '
  .DistributionConfig as $c
  | ($c.CacheBehaviors.Items // []) as $items
  | (first($items[] | select(.PathPattern | test("\\*\\.m3u8\\*?$"))) // $c.DefaultCacheBehavior) as $src
  | $c
  | .CacheBehaviors.Items = ([
      {
        PathPattern: "*.arch.*",
        TargetOriginId: $src.TargetOriginId,
        ViewerProtocolPolicy: $src.ViewerProtocolPolicy,
        AllowedMethods: { Quantity: 2, Items: ["GET", "HEAD"], CachedMethods: { Quantity: 2, Items: ["GET", "HEAD"] } },
        Compress: true,
        SmoothStreaming: false,
        FieldLevelEncryptionId: "",
        CachePolicyId: $policy,
        LambdaFunctionAssociations: { Quantity: 1, Items: [ { LambdaFunctionARN: $arn, EventType: "origin-request", IncludeBody: false } ] },
        FunctionAssociations: { Quantity: 0 }
      }
      + { ResponseHeadersPolicyId: ($src.ResponseHeadersPolicyId // $cors) }
      + (if $src.OriginRequestPolicyId then { OriginRequestPolicyId: $src.OriginRequestPolicyId } else {} end)
      + (if $src.TrustedKeyGroups then { TrustedKeyGroups: $src.TrustedKeyGroups } else {} end)
      + (if $src.TrustedSigners then { TrustedSigners: $src.TrustedSigners } else {} end)
    ] + ($items | map(select(.PathPattern != "*.arch.*"))))
  | .CacheBehaviors.Quantity = (.CacheBehaviors.Items | length)
' "$TMP/dist.json" > "$TMP/config.json"

echo "new behavior:"
jq '.CacheBehaviors.Items[0]' "$TMP/config.json"
aws cloudfront update-distribution --id "$DIST" --if-match "$ETAG" --distribution-config "file://$TMP/config.json" --query 'Distribution.Status' --output text
echo "deploying; the function replicates to edge locations over a few minutes"
echo "the previous config is in $TMP/dist.json"
