# P2P 节点 - 无需单独安装 Go
FROM golang:1.24-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /p2p-node ./cmd/node

FROM alpine:3.19
RUN apk add --no-cache ca-certificates wget
COPY --from=builder /p2p-node /usr/local/bin/p2p-node
EXPOSE 4001 8080
ENTRYPOINT ["p2p-node"]
