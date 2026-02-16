# Optional: run the worker in a container (local or deploy).
# Requires DB_* and REDIS_URL at runtime (env or --env-file).
FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache git
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
CMD ["npm", "run", "worker"]
