.PHONY: help up down logs simulate reset db status build clean health test

# Colors for output
RED := \033[0;31m
GREEN := \033[0;32m
YELLOW := \033[0;33m
NC := \033[0m # No Color

help: ## Show this help message
	@echo "Fleet Telemetry Platform - Local Development Environment"
	@echo "==========================================================="
	@echo ""
	@echo "Usage: make [target]"
	@echo ""
	@echo "Targets:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-20s %s\n", $$1, $$2}'
	@echo ""

up: ## Start all services (core services only, without Odoo)
	@echo "$(GREEN)Starting Fleet Telemetry Platform...$(NC)"
	docker-compose up -d emqx traccar nats timescaledb
	@echo "$(GREEN)✓ Services starting...$(NC)"
	@echo ""
	@echo "Waiting for services to be healthy (this may take 30-60 seconds)..."
	@sleep 15
	@make health

up-with-odoo: ## Start all services including Odoo
	@echo "$(GREEN)Starting Fleet Telemetry Platform with Odoo...$(NC)"
	docker-compose --profile with-odoo up -d
	@echo "$(GREEN)✓ Services starting...$(NC)"
	@echo ""
	@echo "Waiting for services to be healthy (this may take 1-2 minutes)..."
	@sleep 20
	@make health

up-with-service: ## Start all services including L4 Node.js service
	@echo "$(GREEN)Starting Fleet Telemetry Platform with L4 service...$(NC)"
	docker-compose --profile with-service up -d emqx traccar nats timescaledb l4-service
	@echo "$(GREEN)✓ Services starting...$(NC)"
	@echo ""
	@echo "Waiting for services to be healthy..."
	@sleep 15
	@make health

down: ## Stop all services
	@echo "$(YELLOW)Stopping all services...$(NC)"
	docker-compose down
	@echo "$(GREEN)✓ All services stopped$(NC)"

logs: ## Tail logs from all running services
	docker-compose logs -f --tail=50

logs-service: ## Tail logs from a specific service
	@echo "$(YELLOW)Which service? (emqx|traccar|nats|adapter|timescaledb|l4-service|odoo|odoo-db|simulator)$(NC)"
	@read service; docker-compose logs -f --tail=50 $$service

logs-adapter: ## Tail logs from adapter
	docker-compose logs -f --tail=100 adapter

simulate: ## Start GPS device simulator
	@echo "$(GREEN)Starting GPS device simulator...$(NC)"
	docker-compose --profile simulate up -d simulator
	@echo "$(GREEN)✓ Simulator started, sending messages every 30 seconds...$(NC)"
	@echo ""
	docker-compose logs -f simulator

simulate-stop: ## Stop GPS device simulator
	@echo "$(YELLOW)Stopping simulator...$(NC)"
	docker-compose stop simulator
	@echo "$(GREEN)✓ Simulator stopped$(NC)"

reset: ## Delete all data and restart fresh (WARNING: loses all data!)
	@echo "$(RED)⚠️  WARNING: This will DELETE all data volumes!$(NC)"
	@echo "Are you sure? [y/N] " && read ans && [ $${ans:-N} = y ]
	@echo "$(RED)Removing containers...$(NC)"
	docker-compose down -v
	@echo "$(RED)Removing data directory...$(NC)"
	rm -rf ./data
	@echo "$(GREEN)✓ Everything reset. Run 'make up' to start fresh$(NC)"

status: ## Show status of all containers
	@echo "$(YELLOW)Container Status:$(NC)"
	@docker-compose ps --services | sort
	@echo ""
	@docker-compose ps

health: ## Check health of all services
	@echo "$(YELLOW)Checking service health...$(NC)"
	@echo ""
	@echo "EMQX Admin Dashboard:"
	@curl -s -o /dev/null -w "  HTTP Status: %{http_code}\n" http://localhost:18083 || echo "  ✗ Not responding"
	@echo ""
	@echo "Traccar Web UI:"
	@curl -s -o /dev/null -w "  HTTP Status: %{http_code}\n" http://localhost:8082 || echo "  ✗ Not responding"
	@echo ""
	@echo "NATS Monitoring:"
	@curl -s -o /dev/null -w "  HTTP Status: %{http_code}\n" http://localhost:8222/varz || echo "  ✗ Not responding"
	@echo ""
	@echo "TimescaleDB:"
	@docker exec fleet-timescaledb pg_isready -U fleet -d fleet 2>/dev/null && echo "  ✓ Ready" || echo "  ✗ Not responding"
	@echo ""
	@echo "L4 Service (if running):"
	@curl -s -o /dev/null -w "  HTTP Status: %{http_code}\n" http://localhost:3000/health 2>/dev/null || echo "  ✗ Not running"
	@echo ""
	@echo "Odoo (if running):"
	@curl -s -o /dev/null -w "  HTTP Status: %{http_code}\n" http://localhost:8069 2>/dev/null || echo "  ✗ Not running"

db: ## Open TimescaleDB psql shell
	@echo "$(GREEN)Connecting to TimescaleDB...$(NC)"
	docker exec -it fleet-timescaledb psql -U fleet -d fleet

db-backup: ## Backup TimescaleDB to SQL file
	@echo "$(GREEN)Backing up TimescaleDB...$(NC)"
	@mkdir -p ./backups
	docker exec fleet-timescaledb pg_dump -U fleet -d fleet > ./backups/fleet_$(shell date +%Y%m%d_%H%M%S).sql
	@echo "$(GREEN)✓ Backup saved to backups/$(NC)"

build: ## Build simulator Docker image
	@echo "$(GREEN)Building simulator image...$(NC)"
	docker build -t fleet-simulator:latest ./simulator
	@echo "$(GREEN)✓ Build complete$(NC)"

clean: ## Clean up stopped containers and dangling images
	@echo "$(YELLOW)Cleaning up Docker resources...$(NC)"
	docker container prune -f
	docker image prune -f
	@echo "$(GREEN)✓ Cleanup complete$(NC)"

inspect-emqx: ## Inspect EMQX container
	docker exec -it fleet-emqx bash

inspect-traccar: ## Inspect Traccar container
	docker exec -it fleet-traccar bash

inspect-nats: ## Inspect NATS container
	docker exec -it fleet-nats sh

inspect-db: ## Inspect TimescaleDB container
	docker exec -it fleet-timescaledb bash

mqtt-test: ## Test MQTT connection by subscribing to all topics
	@echo "$(GREEN)Subscribing to all MQTT topics (Ctrl+C to stop)...$(NC)"
	mosquitto_sub -h localhost -p 1883 -t "#" -v 2>/dev/null || echo "mosquitto_sub not installed. Run: brew install mosquitto"

nats-monitor: ## Open NATS monitoring UI
	@echo "$(GREEN)Opening NATS monitoring UI at http://localhost:8222$(NC)"
	@command -v open >/dev/null 2>&1 && open http://localhost:8222 || xdg-open http://localhost:8222 2>/dev/null || echo "Please open http://localhost:8222 in your browser"

emqx-dashboard: ## Open EMQX admin dashboard
	@echo "$(GREEN)Opening EMQX dashboard at http://localhost:18083$(NC)"
	@command -v open >/dev/null 2>&1 && open http://localhost:18083 || xdg-open http://localhost:18083 2>/dev/null || echo "Please open http://localhost:18083 in your browser"

traccar-ui: ## Open Traccar web UI
	@echo "$(GREEN)Opening Traccar UI at http://localhost:8082$(NC)"
	@command -v open >/dev/null 2>&1 && open http://localhost:8082 || xdg-open http://localhost:8082 2>/dev/null || echo "Please open http://localhost:8082 in your browser"

test-pipeline: ## Test the complete pipeline: send event through all layers
	@echo "$(GREEN)Testing complete data pipeline...$(NC)"
	@echo ""
	@echo "1. Sending test MQTT message via mosquitto_pub..."
	mosquitto_pub -h localhost -p 1883 -t "telemetry/TEST_DEVICE/raw" \
		-m '{"event_id":"test-uuid","device_id":"TEST_DEVICE","timestamp":"2026-03-20T10:00:00Z","position":{"lat":36.8065,"lng":10.1815,"speed":50},"telemetry":{"ignition":true,"fuel_level":75},"buffered":false}' \
		2>/dev/null || echo "mosquitto_pub not installed. Run: brew install mosquitto"
	@echo ""
	@echo "2. Checking NATS streams..."
	@docker exec fleet-nats nats stream ls 2>/dev/null || echo "Run: docker exec fleet-nats nats stream ls"
	@echo ""
	@echo "3. Querying TimescaleDB for recent events..."
	@docker exec fleet-timescaledb psql -U fleet -d fleet -t -c "SELECT COUNT(*) as event_count FROM telemetry WHERE timestamp > NOW() - INTERVAL '5 minutes';"
	@echo ""
	@echo "$(GREEN)✓ Pipeline test complete$(NC)"

version: ## Show version info
	@echo "Fleet Telemetry Platform - Local Development"
	@echo ""
	@echo "Docker version:"
	@docker --version
	@echo ""
	@echo "Docker Compose version:"
	@docker-compose --version
	@echo ""
	@echo "Services:"
	@echo "  EMQX: 5.3.0"
	@echo "  Traccar: latest"
	@echo "  NATS: 2.10-alpine"
	@echo "  TimescaleDB: latest (PostgreSQL 16)"
	@echo "  Odoo: 17"
	@echo ""

.DEFAULT_GOAL := help
