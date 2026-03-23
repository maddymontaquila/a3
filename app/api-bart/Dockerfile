FROM golang:1.26-alpine AS build
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o api-bart .

FROM alpine:3.21
RUN apk add --no-cache ca-certificates
COPY --from=build /app/api-bart /usr/local/bin/api-bart
EXPOSE 8082
ENV HOST=0.0.0.0
ENV PORT=8082
CMD ["api-bart"]
