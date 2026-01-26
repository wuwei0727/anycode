import React from 'react';
import { cn } from '@/lib/utils';
import type { EngineFilter as EngineFilterType } from '@/lib/api';

interface EngineFilterProps {
  value: EngineFilterType;
  onChange: (filter: EngineFilterType) => void;
  className?: string;
}

const filters: { id: EngineFilterType; label: string; icon?: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'codex', label: 'Codex' },
  { id: 'claude', label: 'Claude' },
  { id: 'gemini', label: 'Gemini' },
];

/**
 * Engine filter component for filtering projects by execution engine
 */
export const EngineFilter: React.FC<EngineFilterProps> = ({
  value,
  onChange,
  className,
}) => {
  return (
    <div className={cn("flex items-center gap-1 p-1 bg-muted/50 rounded-lg", className)}>
      {filters.map((filter) => (
        <button
          key={filter.id}
          onClick={() => onChange(filter.id)}
          className={cn(
            "px-3 py-1.5 text-sm font-medium rounded-md transition-all",
            value === filter.id
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground hover:bg-background/50"
          )}
        >
          {filter.label}
        </button>
      ))}
    </div>
  );
};
