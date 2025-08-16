#!/bin/bash
# Simple EC2 deployment script with SMTP for pure speed and competitive advantage

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
NC='\033[0m'

# Configuration
STACK_NAME="umzugshilfe-smtp"
REGION="eu-central-1"
INSTANCE_TYPE="t3.small"
TEMPLATE_FILE="cloudformation-template.yaml"

echo -e "${BLUE}🚀 Deploying Simplified Umzugshilfe Bot with SMTP${NC}"
echo -e "${BLUE}=================================================${NC}"

log() { echo -e "${GREEN}✅ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
error() { echo -e "${RED}❌ $1${NC}"; exit 1; }
info() { echo -e "${PURPLE}ℹ️  $1${NC}"; }

# Function to check prerequisites
check_prerequisites() {
    info "Checking prerequisites..."
    
    # Check AWS CLI
    command -v aws.cmd >/dev/null 2>&1 || error "AWS CLI not found. Please install it first."
    
    # Check AWS credentials
    aws.cmd sts get-caller-identity >/dev/null 2>&1 || error "AWS credentials not configured. Run 'aws.cmd configure'"
    
    # Check CloudFormation template
    [ ! -f "$TEMPLATE_FILE" ] && error "CloudFormation template '$TEMPLATE_FILE' not found"
    
    # Check .env file
    [ ! -f .env ] && error ".env file not found. Please create it with your credentials."
    
    log "Prerequisites check passed"
}

# Function to load and validate environment
load_environment() {
    info "Loading environment variables..."
    
    source .env
    
    # Check required SMTP variables
    [ -z "$LOGIN_USERNAME" ] && error "LOGIN_USERNAME not set in .env"
    [ -z "$LOGIN_PASSWORD" ] && error "LOGIN_PASSWORD not set in .env"
    [ -z "$EMAIL_ADDRESS" ] && error "EMAIL_ADDRESS not set in .env"
    [ -z "$EMAIL_PASSWORD" ] && error "EMAIL_PASSWORD not set in .env"
    
    # Optional SMTP settings with defaults
    SMTP_HOST=${SMTP_HOST:-"smtp.gmail.com"}
    SMTP_PORT=${SMTP_PORT:-587}
    
    log "Environment variables loaded and validated"
    info "Email: $EMAIL_ADDRESS"
    info "SMTP Host: $SMTP_HOST:$SMTP_PORT"
}

# Function to create or use existing key pair
setup_keypair() {
    KEY_PAIR_NAME="umzugshilfe-key-$(date +%Y%m%d)"
    
    if ! aws.cmd ec2 describe-key-pairs --key-names "$KEY_PAIR_NAME" --region "$REGION" >/dev/null 2>&1; then
        info "Creating new key pair: $KEY_PAIR_NAME"
        aws.cmd ec2 create-key-pair \
            --key-name "$KEY_PAIR_NAME" \
            --region "$REGION" \
            --query 'KeyMaterial' \
            --output text > "${KEY_PAIR_NAME}.pem"
        chmod 400 "${KEY_PAIR_NAME}.pem"
        log "Key pair saved as: ${KEY_PAIR_NAME}.pem"
        echo -e "${YELLOW}🔑 IMPORTANT: Save this key file! You'll need it for SSH access.${NC}"
    else
        log "Using existing key pair: $KEY_PAIR_NAME"
        if [ ! -f "${KEY_PAIR_NAME}.pem" ]; then
            warn "Key file ${KEY_PAIR_NAME}.pem not found locally. You may not be able to SSH."
        fi
    fi
}

# Function to deploy CloudFormation stack
deploy_infrastructure() {
    info "Deploying infrastructure..."
    
    # Check if stack exists
    if aws.cmd cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" >/dev/null 2>&1; then
        info "Stack exists, updating..."
        OPERATION="update"
    else
        info "Creating new stack..."
        OPERATION="create"
    fi
    
    aws.cmd cloudformation deploy \
        --template-file "$TEMPLATE_FILE" \
        --stack-name "$STACK_NAME" \
        --capabilities CAPABILITY_IAM \
        --region "$REGION" \
        --parameter-overrides \
            KeyPairName="$KEY_PAIR_NAME" \
            InstanceType="$INSTANCE_TYPE" \
            LoginUsername="$LOGIN_USERNAME" \
            LoginPassword="$LOGIN_PASSWORD" \
            EmailAddress="$EMAIL_ADDRESS" \
            EmailPassword="$EMAIL_PASSWORD" \
            SMTPHost="$SMTP_HOST" \
            SMTPPort="$SMTP_PORT" \
        --no-fail-on-empty-changeset

    log "Infrastructure deployed successfully"
}

# Function to get stack outputs
get_stack_outputs() {
    info "Retrieving stack outputs..."
    
    INSTANCE_IP=$(aws.cmd cloudformation describe-stacks \
        --stack-name "$STACK_NAME" \
        --region "$REGION" \
        --query 'Stacks[0].Outputs[?OutputKey==`InstancePublicIP`].OutputValue' \
        --output text)

    APP_URL=$(aws.cmd cloudformation describe-stacks \
        --stack-name "$STACK_NAME" \
        --region "$REGION" \
        --query 'Stacks[0].Outputs[?OutputKey==`ApplicationURL`].OutputValue' \
        --output text)

    HEALTH_URL=$(aws.cmd cloudformation describe-stacks \
        --stack-name "$STACK_NAME" \
        --region "$REGION" \
        --query 'Stacks[0].Outputs[?OutputKey==`HealthCheckURL`].OutputValue' \
        --output text)

    SSH_COMMAND=$(aws.cmd cloudformation describe-stacks \
        --stack-name "$STACK_NAME" \
        --region "$REGION" \
        --query 'Stacks[0].Outputs[?OutputKey==`SSHCommand`].OutputValue' \
        --output text)

    if [ -z "$INSTANCE_IP" ]; then
        error "Failed to get instance IP from stack outputs"
    fi

    log "Stack outputs retrieved successfully"
    info "Instance IP: $INSTANCE_IP"
}

# Function to wait for application to be ready
wait_for_application() {
    info "Waiting for application to start..."
    
    local max_attempts=40  # 10 minutes total
    local attempt=1
    
    while [ $attempt -le $max_attempts ]; do
        echo -n "."
        
        if curl -f -s --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
            echo ""
            log "Application is healthy!"
            return 0
        fi
        
        if [ $attempt -eq $max_attempts ]; then
            echo ""
            warn "Health check timeout after 10 minutes."
            warn "Application might still be starting. Check logs with SSH."
            return 1
        fi
        
        sleep 15
        ((attempt++))
    done
}

# Function to test the application
test_application() {
    info "Testing application functionality..."
    
    # Test health endpoint
    if curl -f -s "$HEALTH_URL" >/dev/null 2>&1; then
        local health_response=$(curl -s "$HEALTH_URL" 2>/dev/null)
        log "Health check passed"
        echo "   Response: $health_response"
    else
        warn "Health check failed"
        return 1
    fi
    
    # Test stats endpoint
    if curl -f -s "$APP_URL/stats" >/dev/null 2>&1; then
        log "Stats endpoint accessible"
    else
        warn "Stats endpoint not accessible"
    fi
    
    # Test email functionality
    info "Testing email configuration..."
    local email_test=$(curl -s -X POST "$APP_URL/test-email" 2>/dev/null || echo '{"error":"failed"}')
    if echo "$email_test" | grep -q '"success":true'; then
        log "Email test successful - check your inbox!"
    else
        warn "Email test failed. Check SMTP configuration."
        echo "   Response: $email_test"
    fi
    
    # Test job trigger endpoint
    info "Testing job trigger..."
    local trigger_test=$(curl -s -X POST \
        -H 'Content-Type: application/json' \
        -d '{"jobIds":["TEST123"]}' \
        "$APP_URL/trigger" 2>/dev/null || echo '{"error":"failed"}')
    
    if echo "$trigger_test" | grep -q '"success":true'; then
        log "Job trigger test successful"
    else
        warn "Job trigger test failed"
        echo "   Response: $trigger_test"
    fi
}

# Function to show deployment summary
show_summary() {
    echo ""
    echo -e "${BLUE}🎉 Deployment Complete - SMTP Bot is Ready!${NC}"
    echo -e "${BLUE}===========================================${NC}"
    echo ""
    echo -e "${GREEN}✅ Simplified, fast Umzugshilfe bot with SMTP is LIVE!${NC}"
    echo ""
    echo -e "${YELLOW}📊 Access Information:${NC}"
    echo "  🌐 Application: $APP_URL"
    echo "  💚 Health Check: $HEALTH_URL"
    echo "  📈 Stats: $APP_URL/stats"
    echo ""
    echo -e "${YELLOW}🔧 Management:${NC}"
    echo "  🔐 SSH: $SSH_COMMAND"
    echo "  📄 Key File: ${KEY_PAIR_NAME}.pem"
    echo ""
    echo -e "${YELLOW}🧪 Test Commands:${NC}"
    echo "  💟 Health: curl $HEALTH_URL"
    echo "  📊 Stats: curl $APP_URL/stats"
    echo "  📧 Test Email: curl -X POST $APP_URL/test-email"
    echo "  🧪 Test Jobs: curl -X POST -H 'Content-Type: application/json' -d '{\"jobIds\":[\"TEST123\"]}' $APP_URL/trigger"
    echo ""
    echo -e "${YELLOW}📧 Email Configuration:${NC}"
    echo "  📮 Monitoring: $EMAIL_ADDRESS"
    echo "  🏃 SMTP: $SMTP_HOST:$SMTP_PORT"
    echo "  🔍 Watching for emails from: job@studenten-umzugshilfe.com"
    echo ""
    echo -e "${YELLOW}🚀 Performance Expectations:${NC}"
    echo "  ⚡ Response time: 0.5-1.5 seconds"
    echo "  📧 Email check: Every 30 seconds"
    echo "  🔄 Auto-restart: Enabled"
    echo ""
    echo -e "${GREEN}🎯 Your competitive advantage is now ACTIVE with SMTP!${NC}"
    echo ""
    echo -e "${PURPLE}💡 Next Steps:${NC}"
    echo "  1. Send a test email to verify monitoring"
    echo "  2. Check application logs: ssh + docker logs umzugshilfe"
    echo "  3. Monitor your inbox for success/error notifications"
    echo "  4. Scale up instance if needed: modify INSTANCE_TYPE in script"
    echo ""
    echo -e "${YELLOW}🛠️ Troubleshooting:${NC}"
    echo "  • If health check fails: ssh in and run 'docker logs umzugshilfe'"
    echo "  • If email test fails: verify Gmail app password is correct"
    echo "  • If no job emails: check spam folder and email filters"
    echo "  • For immediate help: curl $APP_URL/stats"
}

# Function to handle cleanup on failure
cleanup_on_failure() {
    warn "Deployment failed. Cleaning up..."
    
    # Optionally delete the stack if it was just created
    read -p "Delete the failed stack? (y/N): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        aws.cmd cloudformation delete-stack --stack-name "$STACK_NAME" --region "$REGION"
        info "Stack deletion initiated"
    fi
}

# Function to save deployment info
save_deployment_info() {
    local info_file="deployment-info.txt"
    
    cat > "$info_file" << EOF
Umzugshilfe SMTP Bot Deployment Info
===================================
Date: $(date)
Stack Name: $STACK_NAME
Region: $REGION
Instance Type: $INSTANCE_TYPE

Endpoints:
- Application: $APP_URL
- Health: $HEALTH_URL
- Stats: $APP_URL/stats

SSH Access:
- Command: $SSH_COMMAND
- Key File: ${KEY_PAIR_NAME}.pem

Email Configuration:
- Address: $EMAIL_ADDRESS
- SMTP: $SMTP_HOST:$SMTP_PORT

Test Commands:
curl $HEALTH_URL
curl $APP_URL/stats
curl -X POST $APP_URL/test-email
curl -X POST -H 'Content-Type: application/json' -d '{"jobIds":["TEST123"]}' $APP_URL/trigger
EOF
    
    log "Deployment info saved to: $info_file"
}

# Main execution flow
main() {
    echo -e "${BLUE}Starting deployment process...${NC}"
    
    # Set up error handling
    trap cleanup_on_failure ERR
    
    # Execute deployment steps
    check_prerequisites
    load_environment
    setup_keypair
    deploy_infrastructure
    get_stack_outputs
    wait_for_application
    test_application
    save_deployment_info
    show_summary
    
    log "Deployment completed successfully!"
}

# Handle command line arguments
case "${1:-}" in
    "destroy")
        info "Destroying stack: $STACK_NAME"
        aws.cmd cloudformation delete-stack --stack-name "$STACK_NAME" --region "$REGION"
        log "Stack deletion initiated"
        exit 0
        ;;
    "status")
        info "Checking stack status..."
        aws.cmd cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" --query 'Stacks[0].StackStatus' --output text
        exit 0
        ;;
    "logs")
        info "Getting recent logs..."
        if [ -f "${KEY_PAIR_NAME}.pem" ]; then
            INSTANCE_IP=$(aws.cmd cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" --query 'Stacks[0].Outputs[?OutputKey==`InstancePublicIP`].OutputValue' --output text)
            ssh -i "${KEY_PAIR_NAME}.pem" -o StrictHostKeyChecking=no ec2-user@"$INSTANCE_IP" "docker logs --tail 50 umzugshilfe"
        else
            error "Key file not found. Cannot SSH to instance."
        fi
        exit 0
        ;;
    "help"|"-h"|"--help")
        echo "Usage: $0 [command]"
        echo ""
        echo "Commands:"
        echo "  (no args)  Deploy the application"
        echo "  destroy    Delete the CloudFormation stack"
        echo "  status     Check stack status"
        echo "  logs       Show recent application logs"
        echo "  help       Show this help message"
        exit 0
        ;;
esac

# Run main deployment
main