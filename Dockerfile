FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server.js worker.js bucket-storage.js dashboard.html dashboard.css dashboard.js logo.png ./
RUN mkdir -p /data/media
ENV PORT=3000
EXPOSE 3000
CMD ["npm","start"]
