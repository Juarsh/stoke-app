# One image for the API: a static Go binary (no cgo) on distroless. All config comes from the environment
# (DATABASE_URL, AUTH_MODE, GOOGLE_CLIENT_IDS, APP_ENV, AI_MODE, GEMINI_API_KEY, PORT, ...; see README "Deploy").
FROM golang:1.24 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/api ./cmd/api \
 && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/stoke-export ./cmd/stoke-export

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/api /out/stoke-export /usr/local/bin/
ENV PORT=8080
EXPOSE 8080
USER nonroot
ENTRYPOINT ["/usr/local/bin/api"]
