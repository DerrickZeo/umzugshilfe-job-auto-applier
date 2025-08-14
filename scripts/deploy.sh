#!/bin/bash
echo "íº€ Deploying to AWS..."

if [ -f .env ]; then
    export $(cat .env | grep -v '^#' | xargs)
fi

# Create deployment package
zip -r deployment.zip src/ node_modules/

# Update Lambda function
aws lambda update-function-code \
  --function-name umzugshilfe-job-processor \
  --zip-file fileb://deployment.zip

echo "âœ… Deployment completed!"
rm deployment.zip
