FROM golang:1.26-alpine AS build

WORKDIR /src
RUN apk add --no-cache ca-certificates

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 go build \
    -trimpath \
    -ldflags="-s -w" \
    -o /out/loungekey-pass \
    ./cmd/loungekey-pass

RUN mkdir -p /out/rootfs/etc/ssl/certs /out/rootfs/tmp \
    && chmod 1777 /out/rootfs/tmp \
    && cp /etc/ssl/certs/ca-certificates.crt /out/rootfs/etc/ssl/certs/ca-certificates.crt

FROM scratch

WORKDIR /app
COPY --from=build /out/loungekey-pass /usr/local/bin/loungekey-pass
COPY --from=build --chown=65532:65532 /out/rootfs/ /

USER 65532:65532
EXPOSE 8080

ENTRYPOINT ["loungekey-pass"]
CMD ["serve", "--host", "0.0.0.0", "--port", "8080"]
