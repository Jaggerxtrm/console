.PHONY: up down build logs ps restart clean prune token help

# ── Config ──────────────────────────────────────────────────────────────────────
COMPOSE      := podman-compose
TOKEN        := $(shell gh auth token 2>/dev/null)

# ── Lifecycle ───────────────────────────────────────────────────────────────────

## Start the XTRM Console host
up:
	GITHUB_TOKEN=$(TOKEN) $(COMPOSE) up -d

## Stop containers
down:
	$(COMPOSE) down

## Build image
build:
	$(COMPOSE) build

## Rebuild from scratch and start
rebuild:
	$(COMPOSE) build --no-cache
	GITHUB_TOKEN=$(TOKEN) $(COMPOSE) up -d

## Restart container
restart:
	$(COMPOSE) restart

# ── Observability ───────────────────────────────────────────────────────────────

## Tail logs
logs:
	$(COMPOSE) logs -f

## Show running containers
ps:
	$(COMPOSE) ps

## Open shell
shell:
	podman exec -it xtrm sh

# ── Health Checks ──────────────────────────────────────────────────────────────

## Check health endpoints
health:
	@echo "XTRM: $$(curl -s http://localhost:3000/health 2>/dev/null || echo 'FAILED')"
	@echo "Console: http://localhost:3000/console"
	@echo "Legacy redirect: http://localhost:3000/gitboard"

# ── Cleanup ─────────────────────────────────────────────────────────────────────

## Remove containers and volumes
clean:
	$(COMPOSE) down -v

## Prune dangling images
prune:
	podman image prune -f

## Full reset
reset: clean build up

# ── Dev helpers ─────────────────────────────────────────────────────────────────

## Print the resolved GITHUB_TOKEN (redacted)
token:
	@echo "GITHUB_TOKEN=$(shell echo $(TOKEN) | cut -c1-8)..."

## Show this help
help:
	@echo "XTRM Console"
	@echo ""
	@echo "Usage: make [target]"
	@echo ""
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/## /  /'

.DEFAULT_GOAL := help
