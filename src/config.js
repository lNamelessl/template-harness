// src/config.js — env parsing with baked defaults (no deploy prompts for derivables).
'use strict';
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR
  || (fs.existsSync('/data') && process.platform !== 'win32' ? '/data' : path.join(__dirname, '..', '.data'));

const config = {
  dataDir: DATA_DIR,
  port: parseInt(process.env.PORT || '3000', 10),

  deepseekBase: (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, ''),
  model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
  deepseekKey: (process.env.DEEPSEEK_API_KEY || '').trim(),

  maxTokens: parseInt(process.env.RESEARCH_MAX_TOKENS || '12000', 10),
  researchConcurrency: Math.max(1, parseInt(process.env.RESEARCH_CONCURRENCY || '1', 10)),

  fastIntervalMin: parseInt(process.env.FAST_INTERVAL_MIN || '60', 10),
  fullRunHour: parseInt(process.env.FULL_RUN_HOUR || '6', 10),
  velocityMinDelta: parseInt(process.env.VELOCITY_MIN_DELTA || '80', 10),

  appPassword: (process.env.APP_ACCESS_PASSWORD || '').trim(),
  telegramToken: (process.env.TELEGRAM_BOT_TOKEN || '').trim(),
  telegramChat: (process.env.TELEGRAM_CHAT_ID || '').trim(),

  // DeepSeek list prices at peak windows (01:00-04:00 + 06:00-10:00 UTC Mon-Fri).
  // Off-peak is half price; estimates here are the HONEST upper band.
  priceSearchPer1k: 0.75,
  priceInPerM: 0.30,
  priceOutPerM: 1.20,
};

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(path.join(config.dataDir, 'artifacts'), { recursive: true });
fs.mkdirSync(path.join(config.dataDir, 'digests'), { recursive: true });

module.exports = config;
