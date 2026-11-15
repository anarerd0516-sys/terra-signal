FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-gdal python3-netcdf4 python3-numpy python3-pil \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json server.mjs index.html nasa.html matched-magnitude.html matched_magnitude.json earth_analog_sites.json nasa_moon_and_mars_locations_dataset.md ./
COPY scripts ./scripts
COPY data/mars-profile.json data/moon-mars-reference.json ./data/
ENV NODE_ENV=production PYTHON_BIN=python3
EXPOSE 3000
CMD ["node", "server.mjs"]
