import type { MantineThemeOverride } from '@mantine/core'

export const theme: MantineThemeOverride = {
  colors: {
    dark: [
      '#1A1B1E',
      '#2C2E33',
      '#373A40',
      '#414449',
      '#4E5259',
      '#5B5F67',
      '#686D76',
      '#757A84',
      '#82858F',
      '#8F929C',
    ],
    brand: [
      '#F0B90B',
      '#E6A700',
      '#CC9600',
      '#B38500',
      '#997400',
      '#806300',
      '#665200',
      '#4D4100',
      '#333100',
      '#1A2000',
    ],
  },
  fontFamily: 'Inter, system-ui, sans-serif',
  headings: { fontFamily: 'Inter, system-ui, sans-serif' },
  primaryColor: 'brand',
  components: {
    Button: {
      defaultProps: {
        size: 'md',
      },
      styles: {
        root: {
          borderRadius: '4px',
          minHeight: '40px',
        },
      },
    },
    Paper: {
      styles: {
        root: {
          backgroundColor: '#1A1B1E',
          borderRadius: '8px',
        },
      },
    },
  },
}
