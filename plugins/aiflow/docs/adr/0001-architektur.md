# ADR-0001: Architektur und Runtime-Adapter

Status: angenommen

AiFlow ist ein eigenständiger Daemon (Engine, API, Web-UI). Agenten laufen über ein `AgentRuntime`-Interface;
erste Implementierung ist ein opencode-Worker mit Treibern für v1 und v2. Die TUI-Integration ist ein Plugin,
das nur über die HTTP-API mit dem Daemon spricht. Details: PLAN.md Kapitel 5.
