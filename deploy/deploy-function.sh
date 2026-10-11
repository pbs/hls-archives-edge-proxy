#!/usr/bin/env bash
# Create or update the Lambda@Edge function in us-east-1 and print the new version ARN.
# The only IAM it creates is one execution role with AWSLambdaBasicExecutionRole (logs).
#
#   deploy/deploy-function.sh [function-name]
set -euo pipefail

NAME="${1:-hls-archives-edge-proxy}"
ROLE="${NAME}-role"
REGION=us-east-1   # Lambda@Edge functions must live here
cd "$(dirname "$0")/.."

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
ZIP="$TMP/function.zip"
(cd src && zip -qr "$ZIP" . -x loopback.mjs)   # loopback.mjs is the stand-in for CloudFront, not needed at the edge

if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  echo "creating role $ROLE"
  aws iam create-role --role-name "$ROLE" --assume-role-policy-document file://deploy/trust-policy.json >/dev/null
  aws iam attach-role-policy --role-name "$ROLE" --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  sleep 10   # let IAM propagate before Lambda tries to assume it
fi
ROLE_ARN=$(aws iam get-role --role-name "$ROLE" --query Role.Arn --output text)

if aws lambda get-function --region "$REGION" --function-name "$NAME" >/dev/null 2>&1; then
  echo "updating code of $NAME"
  aws lambda update-function-code --region "$REGION" --function-name "$NAME" --zip-file "fileb://$ZIP" >/dev/null
  aws lambda wait function-updated --region "$REGION" --function-name "$NAME"
else
  echo "creating function $NAME"
  aws lambda create-function --region "$REGION" --function-name "$NAME" \
    --runtime nodejs22.x --handler handler.handler --role "$ROLE_ARN" \
    --zip-file "fileb://$ZIP" --timeout 25 --memory-size 256 \
    --description "HLS Playlist Archives at the edge" >/dev/null
  aws lambda wait function-active --region "$REGION" --function-name "$NAME"
fi

# Lambda@Edge associations need a numbered version.
VERSION_ARN=$(aws lambda publish-version --region "$REGION" --function-name "$NAME" --query FunctionArn --output text)
echo "published $VERSION_ARN"
echo
echo "next: deploy/attach-behavior.sh <distribution-id> $VERSION_ARN"
