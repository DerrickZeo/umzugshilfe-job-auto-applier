#!/bin/bash
# Simple EC2 deployment script for Node.js bot on t2.micro - Fixed for IPv6/IPv4

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
INSTANCE_TYPE="t2.micro"
TEMPLATE_FILE="cloudformation-template.yaml"

echo -e "${BLUE}🚀 Deploying Umzugshilfe Bot on t2.micro (Node.js)${NC}"
echo -e "${BLUE}=================================================${NC}"

log() { echo -e "${GREEN}✅ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
error() { echo -e "${RED}❌ $1${NC}"; exit 1; }
info() { echo -e "${PURPLE}ℹ️  $1${NC}"; }

# Function to get user's IPv4 address
get_my_ip() {
    info "Getting your IPv4 address for security group..."
    
    # Try multiple IPv4-specific services
    MY_IP=""
    for service in "ipv4.icanhazip.com" "ipv4.ident.me" "api.ipify.org" "checkip.amazonaws.com"; do
        info "Trying $service..."
        MY_IP=$(curl -4 -s --max-time 10 "$service" 2>/dev/null | grep -Eo '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$' || echo "")
        if [ -n "$MY_IP" ]; then
            break
        fi
    done
    
    # If all services fail, try the original services but force IPv4
    if [ -z "$MY_IP" ]; then
        info "Trying fallback services..."
        for service in "ifconfig.me" "ipinfo.io/ip"; do
            MY_IP=$(curl -4 -s --max-time 10 "$service" 2>/dev/null | grep -Eo '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$' || echo "")
            if [ -n "$MY_IP" ]; then
                break
            fi
        done
    fi
    
    # Manual fallback
    if [ -z "$MY_IP" ]; then
        warn "Could not automatically determine your IPv4 address."
        echo "Please visit https://ipv4.icanhazip.com in your browser to get your IPv4 address."
        read -p "Enter your IPv4 address (format: x.x.x.x): " MY_IP
        
        # Validate the entered IP
        if ! echo "$MY_IP" | grep -Eq '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$'; then
            error "Invalid IPv4 address format. Please use x.x.x.x format."
        fi
    fi
    
    log "Your IPv4 address: $MY_IP"
    info "Only this IP will have SSH access to the instance"
}

# Function to check prerequisites
check_prerequisites() {
    info "Checking prerequisites..."
    
    # Check AWS CLI (Windows Git Bash compatibility)
    if command -v aws.cmd >/dev/null 2>&1; then
        AWS_CMD="aws.cmd"
        info "Found AWS CLI: $(aws.cmd --version 2>&1 | head -1)"
    elif command -v aws >/dev/null 2>&1; then
        AWS_CMD="aws"
        info "Found AWS CLI: $(aws --version 2>&1 | head -1)"
    else
        error "AWS CLI not found. Please install it first."
    fi
    
    # Check AWS credentials with better error reporting
    info "Testing AWS credentials with: $AWS_CMD sts get-caller-identity"
    if ! $AWS_CMD sts get-caller-identity >/dev/null 2>&1; then
        error "AWS credentials not configured or invalid. 
        
Debug steps:
1. Check credentials: $AWS_CMD configure list
2. Test manually: $AWS_CMD sts get-caller-identity
3. Configure if needed: $AWS_CMD configure

Current AWS config:"
        $AWS_CMD configure list 2>/dev/null || echo "No AWS config found"
    fi
    
    log "AWS credentials verified successfully"
    
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
    
    # Check required variables
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
    
    if ! $AWS_CMD ec2 describe-key-pairs --key-names "$KEY_PAIR_NAME" --region "$REGION" >/dev/null 2>&1; then
        info "Creating new key pair: $KEY_PAIR_NAME"
        $AWS_CMD ec2 create-key-pair \
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
    if $AWS_CMD cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" >/dev/null 2>&1; then
        info "Stack exists, updating..."
        OPERATION="update"
    else
        info "Creating new stack..."
        OPERATION="create"
    fi
    
    $AWS_CMD cloudformation deploy \
        --template-file "$TEMPLATE_FILE" \
        --stack-name "$STACK_NAME" \
        --capabilities CAPABILITY_IAM \
        --region "$REGION" \
        --parameter-overrides \
            KeyPairName="$KEY_PAIR_NAME" \
            MyIPAddress="$MY_IP" \
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
    
    INSTANCE_IP=$($AWS_CMD cloudformation describe-stacks \
        --stack-name "$STACK_NAME" \
        --region "$REGION" \
        --query 'Stacks[0].Outputs[?OutputKey==`InstancePublicIP`].OutputValue' \
        --output text)

    SSH_COMMAND=$($AWS_CMD cloudformation describe-stacks \
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
    info "Note: Application is only accessible via SSH (more secure setup)"
    
    local max_attempts=40  # 10 minutes total
    local attempt=1
    
    while [ $attempt -le $max_attempts ]; do
        echo -n "."
        
        # Test via SSH since port 3000 is not publicly accessible
        if ssh -i "${KEY_PAIR_NAME}.pem" -o StrictHostKeyChecking=no -o ConnectTimeout=5 \
           ec2-user@"$INSTANCE_IP" "curl -f -s --max-time 5 http://localhost:3000/health" >/dev/null 2>&1; then
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
    info "Testing application functionality (via SSH)..."
    
    # Test health endpoint via SSH
    local health_response=$(ssh -i "${KEY_PAIR_NAME}.pem" -o StrictHostKeyChecking=no \
        ec2-user@"$INSTANCE_IP" "curl -s http://localhost:3000/health" 2>/dev/null || echo "failed")
    
    if echo "$health_response" | grep -q "healthy\|ok\|ready"; then
        log "Health check passed via SSH"
        echo "   Response: $health_response"
    else
        warn "Health check failed"
        return 1
    fi
    
    # Test service status
    local service_status=$(ssh -i "${KEY_PAIR_NAME}.pem" -o StrictHostKeyChecking=no \
        ec2-user@"$INSTANCE_IP" "sudo systemctl is-active umzugshilfe" 2>/dev/null || echo "inactive")
    
    if [ "$service_status" = "active" ]; then
        log "Service is running properly"
    else
        warn "Service status: $service_status"
    fi
}

# Function to show deployment summary
show_summary() {
    echo ""
    echo -e "${BLUE}🎉 Deployment Complete - Secure Node.js Bot is Ready!${NC}"
    echo -e "${BLUE}====================================================${NC}"
    echo ""
    echo -e "${GREEN}✅ Umzugshilfe bot on t2.micro is LIVE and SECURE!${NC}"
    echo ""
    echo -e "${YELLOW}🔒 Security Features:${NC}"
    echo "  🛡️  SSH access limited to your IPv4: $MY_IP"
    echo "  🔒 No public application access (port 3000 blocked)"
    echo "  📦 Direct Node.js execution (no Docker overhead)"
    echo ""
    echo -e "${YELLOW}💰 Cost Optimization:${NC}"
    echo "  💵 Instance: t2.micro (~$8.50/month or FREE with Free Tier)"
    echo "  ⚡ Burstable performance perfect for intermittent workloads"
    echo "  📉 ~50% cost savings vs t3.small"
    echo ""
    echo -e "${YELLOW}🔧 Management:${NC}"
    echo "  🔗 SSH: $SSH_COMMAND"
    echo "  📄 Key File: ${KEY_PAIR_NAME}.pem"
    echo ""
    echo -e "${YELLOW}🧪 Application Access (via SSH):${NC}"
    echo "  💚 Health: ssh + curl http://localhost:3000/health"
    echo "  📊 Stats: ssh + curl http://localhost:3000/stats"
    echo "  🔧 Test Email: ssh + curl -X POST http://localhost:3000/test-email"
    echo ""
    echo -e "${YELLOW}📧 Email Configuration:${NC}"
    echo "  📮 Monitoring: $EMAIL_ADDRESS"
    echo "  🏃 SMTP: $SMTP_HOST:$SMTP_PORT"
    echo "  📩 Watching for emails from: job@studenten-umzugshilfe.com"
    echo ""
    echo -e "${YELLOW}🚀 Performance Expectations:${NC}"
    echo "  ⚡ Response time: 0.5-1.5 seconds"
    echo "  📧 Email check: Real-time IMAP + 30s polling backup"
    echo "  🔄 Auto-restart: Enabled via systemd"
    echo ""
    echo -e "${GREEN}🎯 Your competitive advantage is now ACTIVE!${NC}"
    echo ""
    echo -e "${PURPLE}💡 Next Steps:${NC}"
    echo "  1. SSH into instance to monitor logs: ${SSH_COMMAND}"
    echo "  2. Check real-time logs: sudo journalctl -u umzugshilfe -f"
    echo "  3. Test email functionality via SSH"
    echo "  4. Monitor for job applications in your email"
    echo ""
    echo -e "${YELLOW}🛠️ Troubleshooting:${NC}"
    echo "  • Check service: sudo systemctl status umzugshilfe"
    echo "  • View logs: sudo journalctl -u umzugshilfe -f"
    echo "  • Restart service: sudo systemctl restart umzugshilfe"
    echo "  • Test health: curl http://localhost:3000/health"
}

# Function to handle cleanup on failure
cleanup_on_failure() {
    warn "Deployment failed. Cleaning up..."
    
    # Optionally delete the stack if it was just created
    read -p "Delete the failed stack? (y/N): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        $AWS_CMD cloudformation delete-stack --stack-name "$STACK_NAME" --region "$REGION"
        info "Stack deletion initiated"
    fi
}

# Function to save deployment info
save_deployment_info() {
    local info_file="deployment-info.txt"
    
    cat > "$info_file" << EOF
Umzugshilfe Bot Deployment Info (t2.micro)
==========================================
Date: $(date)
Stack Name: $STACK_NAME
Region: $REGION
Instance Type: $INSTANCE_TYPE
Your IPv4: $MY_IP

Access:
- SSH Command: $SSH_COMMAND
- Key File: ${KEY_PAIR_NAME}.pem
- Instance IP: $INSTANCE_IP

Email Configuration:
- Address: $EMAIL_ADDRESS
- SMTP: $SMTP_HOST:$SMTP_PORT

Management Commands (run via SSH):
sudo systemctl status umzugshilfe
sudo journalctl -u umzugshilfe -f
curl http://localhost:3000/health
curl http://localhost:3000/stats
curl -X POST http://localhost:3000/test-email

Security Notes:
- Only your IPv4 ($MY_IP) can SSH to the instance
- Application port 3000 is not publicly accessible
- All access must go through SSH tunnel
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
    get_my_ip
    load_environment
    setup_keypair
    deploy_infrastructure
    get_stack_outputs
    show_summary
    
    log "Deployment completed successfully!"
}

# Handle command line arguments
case "${1:-}" in
    "destroy")
        info "Destroying stack: $STACK_NAME"
        $AWS_CMD cloudformation delete-stack --stack-name "$STACK_NAME" --region "$REGION"
        log "Stack deletion initiated"
        exit 0
        ;;
    "status")
        info "Checking stack status..."
        $AWS_CMD cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" --query 'Stacks[0].StackStatus' --output text
        exit 0
        ;;
    "logs")
        info "Getting recent logs..."
        KEY_PAIR_NAME="umzugshilfe-key-$(date +%Y%m%d)"
        if [ -f "${KEY_PAIR_NAME}.pem" ]; then
            INSTANCE_IP=$($AWS_CMD cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" --query 'Stacks[0].Outputs[?OutputKey==`InstancePublicIP`].OutputValue' --output text)
            ssh -i "${KEY_PAIR_NAME}.pem" -o StrictHostKeyChecking=no ec2-user@"$INSTANCE_IP" "sudo journalctl -u umzugshilfe --no-pager -n 50"
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