# Local Vite dev server — the same process as `npm run dev`, not the Pages build.
# package.json engines: ^20.19.0 || >=22.12.0. GitHub Pages CI uses Node 22.
FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 5173

# Listen on all interfaces so the published port works. No Firebase env is set
# in this image; the app stays local-only unless Compose or a Vite env file
# supplies the names from .env.example.
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]
