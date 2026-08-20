/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{vue,js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'primary': '#D6002E',
        'primary-light': '#FCE7EC',
        'primary-dark': '#9C0022',
        'text-dark': '#232524',
        'text-main': '#3C3E3D',
        'text-light': '#5E6160',
        'bg-main': '#FFFFFF',
        'bg-subtle': '#F5F6F6',
        'border-color': '#E3E5E4',
        'success': '#1E8E4E',
        'danger': '#D6002E',
        'warning': '#B7791F',
      },
    },
  },
  plugins: [],
}
