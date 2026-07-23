# Podman commands for Console

# Build all images
build:
    podman-compose build

# Build Console only
build-console:
    podman-compose build console

# Start all services
up:
    podman-compose up -d

# Start Console only
up-console:
    podman-compose up -d console

# Stop all services
down:
    podman-compose down

# View logs
logs:
    podman-compose logs -f

# View Console logs
logs-console:
    podman-compose logs -f console

# Restart all services
restart:
    podman-compose restart

# Check health
health:
    curl -s http://localhost:3000/health && echo " - console"

# Pull latest images
pull:
    podman-compose pull

# Remove containers and volumes
clean:
    podman-compose down -v

# Rebuild from scratch
rebuild: clean build up

# Development mode (with hot reload)
dev:
    cd apps/console && bun run dev
