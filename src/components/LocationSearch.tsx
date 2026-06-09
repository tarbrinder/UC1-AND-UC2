import { useState, useRef, useEffect } from 'react';
import { MapPin } from 'lucide-react';

const CITIES = [
  'Mumbai', 'Delhi', 'Bangalore', 'Hyderabad', 'Chennai', 'Kolkata', 'Pune', 'Ahmedabad',
  'Surat', 'Jaipur', 'Lucknow', 'Kanpur', 'Nagpur', 'Indore', 'Thane', 'Bhopal',
  'Visakhapatnam', 'Vadodara', 'Ghaziabad', 'Ludhiana', 'Agra', 'Nashik', 'Faridabad',
  'Meerut', 'Rajkot', 'Varanasi', 'Aurangabad', 'Coimbatore', 'Madurai', 'Kochi',
  'Mangalore', 'Chandigarh', 'Jodhpur', 'Raipur', 'Guwahati', 'Patna', 'Bhubaneswar',
  'Thiruvananthapuram', 'Noida', 'Gurugram', 'Amritsar', 'Jabalpur', 'Vijayawada',
  'Srinagar', 'Dehradun', 'Ranchi', 'Mysore', 'Tiruchirappalli', 'Dhanbad', 'Asansol',
];

interface Props {
  value: string;
  onChange: (val: string) => void;
  placeholder?: string;
}

export default function LocationSearch({ value, onChange, placeholder = 'Search city...' }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value);
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = CITIES.filter(c =>
    c.toLowerCase().includes(query.toLowerCase())
  ).slice(0, 8);

  useEffect(() => {
    setQuery(value);
  }, [value]);

  useEffect(() => {
    function handleOutsideClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center gap-2 border border-gray-200 rounded-lg px-3 py-2 focus-within:border-teal-400 focus-within:ring-2 focus-within:ring-teal-100 bg-white transition-all">
        <MapPin className="w-4 h-4 text-gray-400 shrink-0" />
        <input
          type="text"
          value={query}
          onChange={e => {
            setQuery(e.target.value);
            onChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          className="flex-1 outline-none text-sm text-gray-700 bg-transparent placeholder-gray-400"
        />
      </div>

      {open && filtered.length > 0 && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-xl shadow-lg z-50 overflow-hidden">
          {filtered.map(city => (
            <button
              key={city}
              type="button"
              onMouseDown={() => {
                onChange(city);
                setQuery(city);
                setOpen(false);
              }}
              className="w-full text-left px-4 py-2.5 text-sm text-gray-700 hover:bg-teal-50 hover:text-teal-700 flex items-center gap-2 transition-colors"
            >
              <MapPin className="w-3.5 h-3.5 text-gray-300 shrink-0" />
              {city}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
