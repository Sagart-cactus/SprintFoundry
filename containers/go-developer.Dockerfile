FROM sprintfoundry/agent-base:latest

# Go 1.23
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    && rm -rf /var/lib/apt/lists/*

ENV GOLANG_VERSION=1.23.4
RUN wget -q "https://go.dev/dl/go${GOLANG_VERSION}.linux-amd64.tar.gz" \
    && tar -C /usr/local -xzf "go${GOLANG_VERSION}.linux-amd64.tar.gz" \
    && rm "go${GOLANG_VERSION}.linux-amd64.tar.gz"

ENV PATH="/usr/local/go/bin:/root/go/bin:${PATH}"
ENV GOPATH="/root/go"

# Go tools
RUN go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest \
    && go install gotest.tools/gotestsum@latest \
    && go install golang.org/x/tools/cmd/goimports@latest

WORKDIR /workspace
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
