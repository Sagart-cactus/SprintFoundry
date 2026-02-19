# SprintFoundry — Architecture Agent
# Includes diagramming tools for architecture documentation.

FROM sprintfoundry/agent-base:latest

USER root

# Install diagramming tools
RUN npm install -g @mermaid-js/mermaid-cli

# Install PlantUML (requires Java)
RUN apt-get update && apt-get install -y --no-install-recommends \
    default-jre-headless \
    graphviz \
    && rm -rf /var/lib/apt/lists/*

RUN curl -sSfL -o /usr/local/bin/plantuml.jar \
    https://github.com/plantuml/plantuml/releases/download/v1.2024.8/plantuml-1.2024.8.jar \
    && echo '#!/bin/bash\njava -jar /usr/local/bin/plantuml.jar "$@"' > /usr/local/bin/plantuml \
    && chmod +x /usr/local/bin/plantuml

USER agent
WORKDIR /workspace
