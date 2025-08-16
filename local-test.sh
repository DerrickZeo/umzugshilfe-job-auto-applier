#!/bin/bash
# Local testing script for Umzugshilfe SMTP Bot

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
NC='\033[0m'

log() { echo -e "${GREEN}✅ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
error() { echo -e "${RED}❌ $1${NC}"; exit 1; }
info() { echo -e "${PURPLE}ℹ️  $1${NC}"; }

echo -e "${BLUE}🧪 Local Testing - Umzugshilfe SMTP Bot${NC}"
echo -e "${BLUE}====================================${NC}"

# Check prerequisites
check_prerequisites() {
    info "Checking prerequisites..."
    
    # Check Node.js
    if ! command -v node >/dev/null 2>&1; then
        error "Node.js not found. Please install Node.js 18+"
    fi
    
    local node_version=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$node_version" -lt 18 ]; then
        error "Node.js version 18+ required. Current: $(node -v)"
    fi
    
    # Check npm
    command -v npm >/dev/null 2>&1 || error "npm not found"
    
    # Check Docker (optional)
    if command -v docker >/dev/null 2>&1; then
        log "Docker available for container testing"
    else
        warn "Docker not found - container testing will be skipped"
    fi
    
    log "Prerequisites check passed"
}

# Setup environment
setup_environment() {
    info "Setting up local environment..."
    
    # Create .env if it doesn't exist
    if [ ! -f .env ]; then
        if [ -f .env.example ]; then
            cp .env.example .env
            warn "Created .env from .env.example - please edit with your credentials"
            info "Required variables: LOGIN_USERNAME, LOGIN_PASSWORD, EMAIL_ADDRESS, EMAIL_PASSWORD"
            read -p "Press Enter after editing .env file..."
        else
            error ".env file not found and no .env.example available"
        fi
    fi
    
    # Check if .env has required variables
    source .env
    
    if [ -z "$EMAIL_ADDRESS" ] || [ -z "$EMAIL_PASSWORD" ]; then
        warn "EMAIL_ADDRESS and EMAIL_PASSWORD must be set in .env for email testing"
        warn "Other tests will still work"
    fi
    
    # Set local development defaults
    export NODE_ENV=development
    export PORT=3000
    export DEBUG_MODE=true
    export LOCAL_DEVELOPMENT=true
    
    log "Environment configured for local development"
}

# Install dependencies
install_dependencies() {
    info "Installing dependencies..."
    
    if [ ! -d "node_modules" ]; then
        npm install
    else
        log "Dependencies already installed"
    fi
    
    # Install Playwright browsers if needed
    if [ ! -d "node_modules/playwright" ]; then
        warn "Playwright not found - installing..."
        npm install playwright
    fi
    
    info "Installing Playwright browsers..."
    npx playwright install chromium
    
    log "Dependencies ready"
}

# Test configuration
test_configuration() {
    info "Testing configuration..."
    
    # Test environment variables
    node -e "
        require('dotenv').config();
        console.log('✅ Environment variables loaded');
        console.log('📧 Email:', process.env.EMAIL_ADDRESS || 'Not set');
        console.log('🔐 SMTP Host:', process.env.SMTP_HOST || 'smtp.gmail.com');
        console.log('🔐 SMTP Port:', process.env.SMTP_PORT || '587');
    " 2>/dev/null || warn "Could not test environment variables"
    
    log "Configuration test completed"
}

# Start application in background
start_application() {
    info "Starting application in background..."
    
    # Kill any existing process on port 3000
    if lsof -Pi :3000 -sTCP:LISTEN -t >/dev/null 2>&1; then
        warn "Port 3000 is busy - killing existing process"
        lsof -Pi :3000 -sTCP:LISTEN -t | xargs kill -9 2>/dev/null || true
        sleep 2
    fi
    
    # Start the application
    NODE_ENV=development npm start > app.log 2>&1 &
    APP_PID=$!
    
    echo "$APP_PID" > .app.pid
    
    info "Application started with PID: $APP_PID"
    info "Logs being written to: app.log"
    
    # Wait for application to start
    local attempts=0
    while [ $attempts -lt 30 ]; do
        if curl -s http://localhost:3000/health >/dev/null 2>&1; then
            log "Application is ready!"
            return 0
        fi
        echo -n "."
        sleep 1
        ((attempts++))
    done
    
    error "Application failed to start within 30 seconds"
}

# Run tests
run_tests() {
    info "Running local tests..."
    
    local base_url="http://localhost:3000"
    
    # Test health endpoint
    info "Testing health endpoint..."
    local health_response=$(curl -s "$base_url/health" 2>/dev/null)
    if echo "$health_response" | grep -q '"status":"healthy"'; then
        log "Health check passed"
        echo "   Response: $health_response"
    else
        warn "Health check failed"
        echo "   Response: $health_response"
    fi
    
    # Test stats endpoint
    info "Testing stats endpoint..."
    local stats_response=$(curl -s "$base_url/stats" 2>/dev/null)
    if echo "$stats_response" | grep -q 'totalJobsProcessed'; then
        log "Stats endpoint working"
        echo "   Response: $stats_response"
    else
        warn "Stats endpoint failed"
    fi
    
    # Test email functionality (if configured)
    if [ -n "$EMAIL_ADDRESS" ] && [ -n "$EMAIL_PASSWORD" ]; then
        info "Testing email functionality..."
        local email_response=$(curl -s -X POST "$base_url/test-email" 2>/dev/null)
        if echo "$email_response" | grep -q '"success":true'; then
            log "Email test passed - check your inbox!"
        else
            warn "Email test failed"
            echo "   Response: $email_response"
        fi
    else
        warn "Skipping email test - EMAIL_ADDRESS/EMAIL_PASSWORD not configured"
    fi
    
    # Test job trigger
    info "Testing job trigger endpoint..."
    local trigger_response=$(curl -s -X POST \
        -H 'Content-Type: application/json' \
        -d '{"jobIds":["TEST123", "TEST456"]}' \
        "$base_url/trigger" 2>/dev/null)
    
    if echo "$trigger_response" | grep -q '"success":true'; then
        log "Job trigger test passed"
        echo "   Response: $trigger_response"
    else
        warn "Job trigger test failed"
        echo "   Response: $trigger_response"
    fi
    
    # Test invalid requests
    info "Testing error handling..."
    local error_response=$(curl -s -X POST \
        -H 'Content-Type: application/json' \
        -d '{"invalid":"data"}' \
        "$base_url/trigger" 2>/dev/null)
    
    if echo "$error_response" | grep -q '"error"'; then
        log "Error handling working correctly"
    else
        warn "Error handling may not be working"
    fi
}

# Docker tests
run_docker_tests() {
    if ! command -v docker >/dev/null 2>&1; then
        warn "Docker not available - skipping container tests"
        return
    fi
    
    info "Testing with Docker..."
    
    # Build image
    info "Building Docker image..."
    docker build -t umzugshilfe-local . || {
        warn "Docker build failed"
        return
    }
    
    # Run container
    info "Starting Docker container..."
    docker run -d \
        --name umzugshilfe-test \
        --env-file .env \
        -p 3001:3000 \
        umzugshilfe-local || {
        warn "Docker run failed"
        return
    }
    
    # Wait for container
    sleep 5
    
    # Test container
    if curl -s http://localhost:3001/health >/dev/null 2>&1; then
        log "Docker container test passed"
    else
        warn "Docker container test failed"
    fi
    
    # Cleanup
    docker stop umzugshilfe-test >/dev/null 2>&1 || true
    docker rm umzugshilfe-test >/dev/null 2>&1 || true
    
    log "Docker tests completed"
}

# Show logs
show_logs() {
    if [ -f app.log ]; then
        info "Recent application logs:"
        tail -20 app.log
    else
        warn "No log file found"
    fi
}

# Cleanup
cleanup() {
    info "Cleaning up..."
    
    # Kill application
    if [ -f .app.pid ]; then
        local pid=$(cat .app.pid)
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true
            log "Application stopped (PID: $pid)"
        fi
        rm -f .app.pid
    fi
    
    # Cleanup Docker containers
    docker stop umzugshilfe-test >/dev/null 2>&1 || true
    docker rm umzugshilfe-test >/dev/null 2>&1 || true
    
    log "Cleanup completed"
}

# Show interactive menu
show_menu() {
    echo ""
    echo -e "${YELLOW}🎮 Interactive Testing Menu${NC}"
    echo "========================="
    echo "1. View health status"
    echo "2. View stats"
    echo "3. Send test email"
    echo "4. Trigger test job"
    echo "5. View logs (tail -f)"
    echo "6. Test Docker build"
    echo "7. Exit"
    echo ""
    
    while true; do
        read -p "Choose option (1-7): " choice
        case $choice in
            1)
                curl -s http://localhost:3000/health | jq . 2>/dev/null || curl -s http://localhost:3000/health
                ;;
            2)
                curl -s http://localhost:3000/stats | jq . 2>/dev/null || curl -s http://localhost:3000/stats
                ;;
            3)
                curl -s -X POST http://localhost:3000/test-email | jq . 2>/dev/null || curl -s -X POST http://localhost:3000/test-email
                ;;
            4)
                curl -s -X POST -H 'Content-Type: application/json' -d '{"jobIds":["MANUAL_TEST"]}' http://localhost:3000/trigger | jq . 2>/dev/null || curl -s -X POST -H 'Content-Type: application/json' -d '{"jobIds":["MANUAL_TEST"]}' http://localhost:3000/trigger
                ;;
            5)
                echo "Press Ctrl+C to stop log viewing"
                tail -f app.log 2>/dev/null || echo "No logs available"
                ;;
            6)
                run_docker_tests
                ;;
            7)
                break
                ;;
            *)
                warn "Invalid choice. Please choose 1-7."
                ;;
        esac
        echo ""
    done
}

# Main execution
main() {
    # Set up cleanup trap
    trap cleanup EXIT
    
    case "${1:-}" in
        "start")
            check_prerequisites
            setup_environment
            install_dependencies
            start_application
            log "Application started. Access it at: http://localhost:3000"
            log "Run './local-test.sh test' to run tests"
            ;;
        "test")
            run_tests
            ;;
        "docker")
            run_docker_tests
            ;;
        "logs")
            show_logs
            ;;
        "menu"|"interactive")
            show_menu
            ;;
        "stop")
            cleanup
            ;;
        *)
            # Full test suite
            check_prerequisites
            setup_environment
            install_dependencies
            test_configuration
            start_application
            run_tests
            
            echo ""
            log "All tests completed!"
            echo ""
            echo -e "${BLUE}🎮 What's next?${NC}"
            echo "• View app: http://localhost:3000"
            echo "• View health: http://localhost:3000/health"
            echo "• View stats: http://localhost:3000/stats"
            echo "• Interactive menu: ./local-test.sh menu"
            echo "• View logs: ./local-test.sh logs"
            echo "• Stop app: ./local-test.sh stop"
            echo ""
            
            # Ask if user wants interactive menu
            read -p "Start interactive menu? (y/N): " -n 1 -r
            echo
            if [[ $REPLY =~ ^[Yy]$ ]]; then
                show_menu
            fi
            ;;
    esac
}

# Show help
if [[ "${1:-}" == "help" ]] || [[ "${1:-}" == "-h" ]] || [[ "${1:-}" == "--help" ]]; then
    echo "Usage: $0 [command]"
    echo ""
    echo "Commands:"
    echo "  (no args)    Run full test suite"
    echo "  start        Start application only"
    echo "  test         Run tests (app must be running)"
    echo "  docker       Test Docker build and run"
    echo "  logs         Show recent logs"
    echo "  menu         Interactive testing menu"
    echo "  stop         Stop application"
    echo "  help         Show this help"
    echo ""
    echo "Examples:"
    echo "  $0           # Full test suite"
    echo "  $0 start     # Start app and leave running"
    echo "  $0 menu      # Interactive testing"
    exit 0
fi

# Run main function
main "$@"