# Umzugshilfe Job Auto-Applier Documentation

## Overview

The Umzugshilfe Job Auto-Applier is an automated system that monitors your email for new job notifications from Studenten Umzugshilfe and automatically applies to them using browser automation. The system is designed for maximum speed and competitive advantage in securing moving jobs.

### Key Features

- **Real-time Email Monitoring**: IMAP push notifications + 30s polling backup
- **Lightning-fast Applications**: 0.5-1.5 second response times
- **Browser Automation**: Automated login and job application process
- **SSH-only Security**: Application runs securely with no public internet access
- **Cost-effective**: Runs on AWS t2.micro (~$8.50/month or FREE with AWS Free Tier)
- **Auto-restart**: Self-healing with systemd service management

## Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────────┐
│   Email Server  │───▶│   EC2 Instance   │───▶│  Umzugshilfe.com   │
│  (Gmail IMAP)   │    │  (Node.js Bot)   │    │   (Applications)   │
└─────────────────┘    └──────────────────┘    └─────────────────────┘
                              │
                              ▼
                       ┌──────────────────┐
                       │   SSH Access     │
                       │   (Your IP Only) │
                       └──────────────────┘
```

### Components

- **Email Watcher**: Monitors Gmail for job notifications using SMTP + IMAP
- **Browser Automator**: Uses Playwright to automate job applications
- **Express Server**: Provides health checks and manual triggers via SSH
- **CloudFormation**: Infrastructure as Code for reliable deployment
- **EC2 Instance**: Amazon Linux 2023 t2.micro with all dependencies

## Prerequisites

### 1. AWS Account Setup

- AWS account with programmatic access
- AWS CLI installed and configured
- Sufficient permissions for EC2, CloudFormation, and IAM

### 2. Gmail App Password

1. Enable 2-Factor Authentication on your Google account
2. Generate an App Password:
   - Go to Google Account settings
   - Security → 2-Step Verification → App Passwords
   - Generate password for "Mail"
   - Save the 16-character password

### 3. Umzugshilfe Account

- Active account on studenten-umzugshilfe.com
- Username and password for automated login

### 4. Development Environment

- Git Bash, Command Prompt, or PowerShell
- AWS CLI v1.42+ or v2.x

## Installation

### 1. Clone the Repository

```bash
git clone https://github.com/DerrickZeo/umzugshilfe-job-auto-applier.git
cd umzugshilfe-job-auto-applier
```

### 2. Create Environment Configuration

Create a `.env` file with your credentials:

```bash
# Umzugshilfe Login
LOGIN_USERNAME=your_umzugshilfe_username
LOGIN_PASSWORD=your_umzugshilfe_password

# Gmail Configuration
EMAIL_ADDRESS=your_email@gmail.com
EMAIL_PASSWORD=your_16_character_app_password

# SMTP Settings (defaults provided)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
EMAIL_SECURE=true
```

### 3. Configure AWS CLI

```bash
aws configure
# Enter your AWS Access Key ID
# Enter your AWS Secret Access Key
# Enter your default region (e.g., eu-central-1)
# Enter default output format (json)
```

## Deployment

### Quick Deployment

```bash
# Make deployment script executable
chmod +x deployment-simple-t2.sh

# Deploy the application
./deployment-simple-t2.sh
```

### Deployment Process

The deployment script will:

1. **Validate Prerequisites**

   - Check AWS CLI and credentials
   - Validate environment variables
   - Verify CloudFormation template

2. **Security Setup**

   - Detect your IPv4 address
   - Create/use SSH key pair
   - Restrict access to your IP only

3. **Infrastructure Deployment**

   - Create CloudFormation stack
   - Launch EC2 t2.micro instance
   - Configure security groups

4. **Application Setup**

   - Install Node.js and dependencies
   - Install Playwright browser automation
   - Configure systemd service
   - Start monitoring service

5. **Validation**
   - Test SSH connectivity
   - Verify application health
   - Confirm service status

### Expected Output

```
🚀 Deploying SSH-Only Umzugshilfe Bot on t2.micro
================================================
✅ Prerequisites verified
✅ Your IPv4: xxx.xxx.xxx.xxx (SSH access restricted to this IP only)
✅ Environment loaded - Email: your@email.com, SMTP: smtp.gmail.com:587
✅ Using existing key pair: umzugshilfe-key-20250817
✅ Infrastructure deployed successfully
✅ Instance deployed at: xxx.xxx.xxx.xxx
✅ Application is healthy and running!
✅ SSH access and application verified
🎉 SSH-Only Umzugshilfe Bot Deployed Successfully!
```

## Management

### SSH Access

```bash
# Connect to your instance
ssh -i umzugshilfe-key-YYYYMMDD.pem ec2-user@YOUR_INSTANCE_IP

# Or use the deployment script shortcut
./deployment-simple-t2.sh ssh
```

### Health Monitoring

```bash
# Check application health
curl http://localhost:3000/health

# View application statistics
curl http://localhost:3000/stats

# Test email functionality
curl -X POST http://localhost:3000/test-email
```

### Service Management

```bash
# Check service status
sudo systemctl status umzugshilfe

# View real-time logs
sudo journalctl -u umzugshilfe -f

# Restart service
sudo systemctl restart umzugshilfe

# Stop service
sudo systemctl stop umzugshilfe

# Start service
sudo systemctl start umzugshilfe
```

### Remote Monitoring

```bash
# View logs from local machine
./deployment-simple-t2.sh logs

# Check stack status
./deployment-simple-t2.sh status
```

## Configuration

### Application Endpoints

All endpoints are accessible only via SSH tunnel:

- `GET /health` - Application health check
- `GET /stats` - Performance statistics
- `POST /trigger` - Manual job application trigger
- `POST /test-email` - Test email sending

### Environment Variables

| Variable         | Description          | Required | Default        |
| ---------------- | -------------------- | -------- | -------------- |
| `LOGIN_USERNAME` | Umzugshilfe username | Yes      | -              |
| `LOGIN_PASSWORD` | Umzugshilfe password | Yes      | -              |
| `EMAIL_ADDRESS`  | Gmail address        | Yes      | -              |
| `EMAIL_PASSWORD` | Gmail app password   | Yes      | -              |
| `SMTP_HOST`      | SMTP server          | No       | smtp.gmail.com |
| `SMTP_PORT`      | SMTP port            | No       | 587            |
| `NODE_ENV`       | Environment mode     | No       | production     |
| `PORT`           | Application port     | No       | 3000           |

### Email Monitoring

The system monitors emails from `job@studenten-umzugshilfe.com` and extracts:

- Job IDs from subject lines and URLs
- Date, time, and location information
- Automatic job application triggers

## Troubleshooting

### Common Issues

#### 1. Deployment Hangs

```bash
# Check CloudFormation status
aws cloudformation describe-stack-events --stack-name umzugshilfe-smtp --region eu-central-1

# View EC2 instance logs
# SSH into instance and check: /var/log/user-data.log
```

#### 2. Service Won't Start

```bash
# Check service logs
sudo journalctl -u umzugshilfe --no-pager -n 50

# Common issues:
# - Missing Playwright dependencies
# - Invalid environment variables
# - Port already in use
```

#### 3. Email Authentication Fails

```bash
# Test SMTP connection
curl -X POST http://localhost:3000/test-email

# Verify app password is correct (16 characters)
# Ensure 2FA is enabled on Google account
```

#### 4. Browser Automation Fails

```bash
# Install missing dependencies
sudo yum install -y atk at-spi2-atk cups-libs libxcb libxkbcommon
npx playwright install chromium --force

# Test manually
node app.js
```

### Log Locations

- **Application logs**: `sudo journalctl -u umzugshilfe -f`
- **System logs**: `/var/log/messages`
- **Deployment logs**: `/var/log/user-data.log`
- **Service definition**: `/etc/systemd/system/umzugshilfe.service`

## Security

### Security Features

- **IP Restriction**: SSH access limited to your IP address only
- **No Public Access**: Application port 3000 is blocked from internet
- **Encrypted Storage**: Credentials stored in AWS Systems Manager
- **Minimal Attack Surface**: Only SSH port exposed
- **Automatic Updates**: System packages updated during deployment

### Best Practices

- Keep your `.pem` key file secure and private
- Don't share your environment variables
- Monitor application logs regularly
- Update your IP address if it changes
- Use strong passwords for all accounts

## Cost Optimization

### AWS Free Tier Eligible

- **EC2 t2.micro**: 750 hours/month free for first 12 months
- **Data Transfer**: 1GB/month free outbound
- **Total Cost**: $0/month for first year (with Free Tier)

### Post-Free Tier Costs (EU-Central-1)

- **EC2 t2.micro**: ~$8.50/month
- **Data Transfer**: ~$0.50/month
- **EBS Storage**: ~$0.80/month (8GB)
- **Total**: ~$9.80/month

### Cost Reduction Tips

- Stop instance when not needed (but emails won't be monitored)
- Use AWS budgets to monitor spending
- Consider scheduled start/stop for specific hours

## Monitoring & Performance

### Performance Metrics

- **Response Time**: 0.5-1.5 seconds typical
- **Email Check Frequency**: Real-time + 30s polling backup
- **Success Rate**: >95% typical (depends on site availability)
- **Memory Usage**: ~200-300MB typical
- **CPU Usage**: <5% typical, bursts during applications

### Health Monitoring

```bash
# Application health endpoint
curl http://localhost:3000/health
# Response: {"status":"healthy","uptime":12345,"browserReady":true,"emailConnected":true}

# Detailed statistics
curl http://localhost:3000/stats
# Response: {"totalJobsProcessed":42,"successCount":40,"failCount":2,"successRate":95}
```

## Deployment Commands Reference

### Basic Operations

```bash
# Deploy application
./deployment-simple-t2.sh

# SSH into instance
./deployment-simple-t2.sh ssh

# View recent logs
./deployment-simple-t2.sh logs

# Check stack status
./deployment-simple-t2.sh status

# Show help
./deployment-simple-t2.sh help
```

### Stack Management

```bash
# Destroy everything
./deployment-simple-t2.sh destroy

# Check deployment info
cat deployment-info.txt
```

## Destroying the Stack

### Complete Cleanup

```bash
# Destroy all AWS resources
./deployment-simple-t2.sh destroy
```

This will:

- Delete the EC2 instance
- Remove the security group
- Delete SSM parameters
- Remove IAM roles and policies
- Clean up all CloudFormation resources

### Manual Cleanup (if needed)

```bash
# Delete CloudFormation stack manually
aws cloudformation delete-stack --stack-name umzugshilfe-smtp --region eu-central-1

# Delete SSH key pair (optional)
aws ec2 delete-key-pair --key-name umzugshilfe-key-YYYYMMDD --region eu-central-1

# Remove local files
rm -f umzugshilfe-key-*.pem deployment-info.txt
```

## Support

### Getting Help

1. Check the troubleshooting section above
2. Review application logs: `sudo journalctl -u umzugshilfe -f`
3. Verify all prerequisites are met
4. Check AWS CloudFormation events for deployment issues

### Contributing

- Report issues with detailed logs
- Submit pull requests for improvements
- Share optimization ideas

### Disclaimer

This tool is for educational and automation purposes. Users are responsible for:

- Complying with Umzugshilfe terms of service
- Ensuring account security
- Monitoring application behavior
- AWS costs and resource management

---

## Quick Start Summary

1. **Setup**: Create `.env` file with credentials
2. **Deploy**: Run `./deployment-simple-t2.sh`
3. **Monitor**: SSH in and check `sudo journalctl -u umzugshilfe -f`
4. **Test**: `curl http://localhost:3000/health`
5. **Destroy**: Run `./deployment-simple-t2.sh destroy` when done

Your competitive advantage in job applications is now automated! 🚀
