.PHONY: help build up down restart logs ps clean deploy

COMPOSE := docker compose
SERVICE := nuxtjs-ai

help:
	@echo "用法（在 apps/nuxtjs-ai 目录执行）:"
	@echo "  make build    构建 Docker 镜像"
	@echo "  make up       后台启动容器"
	@echo "  make deploy   构建并启动（一键部署）"
	@echo "  make down     停止并删除容器"
	@echo "  make restart  重新构建并启动"
	@echo "  make logs     动态查看服务日志"
	@echo "  make ps       查看容器状态"
	@echo "  make clean    停止容器并删除本地镜像"

build:
	$(COMPOSE) build

up:
	$(COMPOSE) up -d

deploy: build up
	@echo "已部署: http://127.0.0.1:3000"

down:
	$(COMPOSE) down

restart: down build up

logs:
	$(COMPOSE) logs -f $(SERVICE)

ps:
	$(COMPOSE) ps

clean: down
	-docker rmi nuxtjs-ai:local 2>/dev/null || true
