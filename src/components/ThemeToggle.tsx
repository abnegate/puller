import { Monitor, Moon, Sun } from 'lucide-react';

import { useTheme, type Theme } from '@/theme';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const themes: Array<{
  icon: typeof Sun;
  label: string;
  value: Theme;
}> = [
  { icon: Sun, label: 'Light', value: 'light' },
  { icon: Moon, label: 'Dark', value: 'dark' },
  { icon: Monitor, label: 'System', value: 'system' },
];

const labelFor = (theme: Theme): string =>
  themes.find((option) => option.value === theme)?.label ?? 'System';

export default function ThemeToggle() {
  const { resolvedTheme, setTheme, theme } = useTheme();
  const Icon = theme === 'system' ? Monitor : resolvedTheme === 'dark' ? Moon : Sun;
  const label = labelFor(theme);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={`Theme: ${label}`}
          className="min-h-11 min-w-11 sm:min-h-7 sm:min-w-7"
          size="icon-sm"
          title={`Theme: ${label}`}
          type="button"
          variant="outline"
        >
          <Icon aria-hidden="true" />
          <span className="sr-only">Choose color theme</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36">
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          onValueChange={(value) => setTheme(value as Theme)}
          value={theme}
        >
          {themes.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              <option.icon aria-hidden="true" />
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
