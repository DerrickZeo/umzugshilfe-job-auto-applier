#!/bin/bash
echo "� Setting up Umzugshilfe Job Auto-Applier..."

if ! command -v node &> /dev/null; then
    echo "❌ Node.js required"
    exit 1
fi

npm install

if [ ! -f .env ]; then
    cp .env.example .env
    echo "⚠️ Edit .env file with your credentials"
fi

echo "✅ Setup completed!"
