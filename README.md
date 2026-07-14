# 🏋️ IRONLOG

App de treino de academia — PWA leve, offline-first, sem backend. Cole seu treino em texto e o app organiza tudo por dia, com séries, cargas, cronômetros e histórico.

*A gym workout tracker — a lightweight, offline-first PWA with no backend. Paste your workout as plain text and the app organizes it by day, with sets, loads, timers, and history.*

---

## 🇧🇷 Português

### O que faz
- **Cole seu treino** (do ChatGPT, lista simples, tabela) e o app identifica dias, exercícios, séries, repetições e descanso automaticamente.
- **Marque séries** com um toque e acompanhe o progresso de cada dia.
- **Cronômetro geral do treino** e **cronômetro por exercício**, com suporte a exercícios cronometrados (prancha, bike etc.) em tela cheia.
- **Carga (kg) por exercício**, lembrada automaticamente da última vez.
- **Histórico** completo dos treinos realizados, com anotações.
- **100% offline** — dados salvos no `localStorage` do navegador, com exportação/importação de backup em JSON.
- **PWA instalável**, com suporte a tela cheia.

### Tecnologias
HTML, CSS e JavaScript puros (sem frameworks, sem build). Service Worker para cache/offline.

### Rodando localmente
Basta abrir o `index.html` num navegador, ou servir a pasta com qualquer servidor estático:
```bash
npx serve .
```

### Deploy (Vercel)
```bash
npm install -g vercel
vercel --prod
```

### Estrutura
```
index.html      → app inteiro (HTML + CSS + JS)
manifest.json    → configuração do PWA
sw.js            → service worker (cache offline)
icon-192.png / icon-512.png → ícones do app
```

### Aviso
Os dados ficam salvos apenas no navegador/dispositivo usado. Use o botão de exportar (💾) para fazer backup regularmente.

---

## 🇺🇸 English

### What it does
- **Paste your workout** (from ChatGPT, a simple list, or a table) and the app automatically detects days, exercises, sets, reps, and rest.
- **Tap to log sets** and track progress for each day.
- **Overall workout timer** and **per-exercise timer**, with a dedicated fullscreen mode for timed exercises (plank, bike, etc.).
- **Load (kg) tracking** per exercise, automatically remembered from your last session.
- **Full workout history**, with optional notes.
- **100% offline** — data is stored in the browser's `localStorage`, with JSON backup export/import.
- **Installable PWA**, with fullscreen support.

### Tech stack
Plain HTML, CSS, and JavaScript (no frameworks, no build step). Service Worker for offline caching.

### Running locally
Just open `index.html` in a browser, or serve the folder with any static server:
```bash
npx serve .
```

### Deploy (Vercel)
```bash
npm install -g vercel
vercel --prod
```

### Project structure
```
index.html      → the entire app (HTML + CSS + JS)
manifest.json    → PWA configuration
sw.js            → service worker (offline caching)
icon-192.png / icon-512.png → app icons
```

### Note
Data is stored only in the browser/device you use. Use the export button (💾) to back up regularly.
