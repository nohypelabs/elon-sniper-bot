FROM node:22-alpine

RUN npm install -g pnpm

WORKDIR /app

# Install root dependencies
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Install dashboard dependencies
COPY dashboard/package.json dashboard/pnpm-lock.yaml ./dashboard/
RUN pnpm --filter ./dashboard install --frozen-lockfile

# Copy source
COPY . .

# Build TypeScript + dashboard
RUN pnpm build

EXPOSE 3001

CMD ["node", "dist/index.js"]
