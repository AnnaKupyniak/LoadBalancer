FROM node:18

WORKDIR /app

COPY package*.json ./

RUN npm install
RUN npm install redis@4.0.0  # Додаємо Redis клієнт

COPY . .

EXPOSE 8001

CMD ["node", "app.js"]