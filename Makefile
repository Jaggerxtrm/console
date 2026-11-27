.PHONY: up down build logs ps restart clean prune token help deploy-native

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

# ── Native host (console.service) ──────────────────────────────────────────────
# Production runs natively as the systemd user unit console.service from this checkout
# (deploy/systemd/console.service), not through podman. A deploy fast-forwards this checkout
# to origin/main (--ff-only refuses a diverged checkout), installs the locked dependencies, restarts
# the unit and retries /health until it answers. It refuses to run on any branch but main.
# Uncommitted files the update does not touch are left in place; one it touches makes the merge
# refuse before the restart.
# The unit binds HOST from ~/.config/xtrm/console.env; pass CONSOLE_HEALTH_URL for that address.
CONSOLE_HEALTH_URL ?= http://127.0.0.1:3030/health
# The unit runs %h/.bun/bin/bun; a non-interactive shell may not have bun on PATH.
BUN ?= $(HOME)/.bun/bin/bun

## Deploy console.service: fast-forward to origin/main, install deps, restart, verify /health
deploy-native:
	git symbolic-ref --short HEAD | grep -qx main
	git fetch origin main
	git merge --ff-only origin/main
	$(BUN) install --frozen-lockfile
	systemctl --user restart console.service
	curl -fsS --retry 15 --retry-delay 2 --retry-connrefused -o /dev/null -w "health %{http_code}\n" $(CONSOLE_HEALTH_URL)
	systemctl --user is-active console.service
	git log --oneline -1

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
