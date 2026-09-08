module.exports = {
  content: ['./static/**/*.{html,js}'],
  theme: {
    extend: {
      colors: {
        gf: {
          bg: '#0f0f1a',
          card: 'rgba(255,255,255,0.03)',
          accent: '#ff6b4a',
          accent2: '#4ecdc4',
          text: '#f0f0f5',
          muted: '#6b6b7b'
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        display: ['Space Grotesk', 'sans-serif']
      }
    }
  },
  plugins: [require('daisyui')],
  daisyui: { themes: [] }
}
