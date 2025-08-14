#!/bin/bash
echo "Ì∫Ä Setting up Umzugshilfe Job Auto-Applier..."

if ! command -v node &> /dev/null; then
    echo "‚ùå Node.js required"
    exit 1
fi

npm install

if [ ! -f .env ]; then
    cp .env.example .env
    echo "‚ö†Ô∏è Edit .env file with your credentials"
fi

echo "‚úÖ Setup completed!"
