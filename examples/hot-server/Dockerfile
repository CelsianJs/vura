FROM node:20-alpine
WORKDIR /app
COPY . .
RUN npm install esbuild
# Bundle the server + route handlers into a single file
RUN npx esbuild server.js --bundle --platform=node --target=node20 --outfile=dist/server.mjs --format=esm
CMD ["node", "dist/server.mjs"]
EXPOSE 3000
