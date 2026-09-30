FROM oven/bun:1.3.11
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src/ ./src/
COPY web/ ./web/
ENV HOST=0.0.0.0 DB_PATH=/data/invoices.sqlite
EXPOSE 8787
CMD ["bun", "src/server.mjs"]
