# Builds the worker from a parent context that contains both sibling repos:
# - mordecai-api/
# - mordecai-workers/
#
# This is required because mordecai-workers depends on `mordcai-api` via
# `file:../mordecai-api`.
FROM node:20-alpine
WORKDIR /app

RUN apk add --no-cache git

COPY mordecai-api /mordecai-api
COPY mordecai-workers/package*.json ./
RUN npm ci --omit=dev
COPY mordecai-workers ./

CMD ["npm", "run", "worker"]
