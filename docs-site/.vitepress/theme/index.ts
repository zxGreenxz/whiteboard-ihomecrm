import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import DemoResetButton from './DemoResetButton.vue'
import SandboxTry from './SandboxTry.vue'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('DemoResetButton', DemoResetButton)
    app.component('SandboxTry', SandboxTry)
  },
} satisfies Theme
