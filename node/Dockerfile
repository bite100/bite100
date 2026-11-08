# P2P 节点 - 无需单独安装 Go
# builder 的 Go 版本必须 >= go.mod 的 go 指令（当前 1.26.8）；版本漂移由
# node-tests.yml 的 docker-build job 兜底检查（第 32 轮起）。
FROM golang:1.26-alpine AS builder
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
