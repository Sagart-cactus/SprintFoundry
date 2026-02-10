# AgentSDLC — Security Agent
# Security scanning tools: npm audit, Snyk, TruffleHog, Trivy, semgrep.

FROM agentsdlc/agent-base:latest

USER root

# Install security scanning tools
RUN npm install -g snyk semgrep

# Install TruffleHog
RUN curl -sSfL https://raw.githubusercontent.com/trufflesecurity/trufflehog/main/scripts/install.sh | sh -s -- -b /usr/local/bin

# Install Trivy
RUN curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b /usr/local/bin

USER agent
WORKDIR /workspace
