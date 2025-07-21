const winston = require('winston');

// Konfigurasi level log sesuai standar npm.
const logLevels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3, // Level untuk log request HTTP
  debug: 4, // Log yang sangat detail untuk development
};

// Menentukan level log berdasarkan environment.
// Default ke 'info' jika tidak disetel. Setel LOG_LEVEL=debug untuk development.
const level = process.env.LOG_LEVEL || 'info';

// Membuat format yang berbeda untuk development dan production.
const devFormat = winston.format.combine(
  winston.format.colorize(), // Memberi warna pada output console
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(info => `${info.timestamp} [${info.level}]: ${info.message}`)
);

const prodFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }), // Jika ada error, sertakan stack trace
  winston.format.json() // Format output sebagai JSON
);

// Pilih format berdasarkan environment Node.js
// Setel NODE_ENV=production untuk log JSON.
const format = process.env.NODE_ENV === 'production' ? prodFormat : devFormat;

const logger = winston.createLogger({
  level: level,
  levels: logLevels,
  format: format,
  transports: [
    // Semua log akan ditampilkan di console.
    // Di lingkungan produksi, ini bisa di-pipe ke file atau layanan logging.
    new winston.transports.Console(),
  ],
  exitOnError: false, // Jangan keluar dari aplikasi jika terjadi error yang tidak tertangani
});

// Middleware untuk logging request Express
logger.stream = {
  write: (message) => {
    logger.http(message.trim());
  },
};

module.exports = logger;
