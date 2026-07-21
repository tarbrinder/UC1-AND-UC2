interface Props {
  step: 0 | 1 | 2;
}

const STEPS = ['Product', 'Specifications', 'More Details'];

export default function StepIndicator({ step }: Props) {
  return (
    <div className="flex items-center gap-1 w-full">
      {STEPS.map((label, i) => {
        const done = i < step;
        const active = i === step;
        return (
          <div key={label} className="flex-1 flex flex-col gap-1">
            <div className={[
              'h-1 rounded-full transition-all duration-500',
              done ? 'bg-teal-500' : active ? 'bg-teal-400' : 'bg-gray-200',
            ].join(' ')} />
            <span className={[
              'text-[10px] font-semibold text-center',
              active ? 'text-teal-600' : done ? 'text-teal-400' : 'text-gray-300',
            ].join(' ')}>
              {label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
