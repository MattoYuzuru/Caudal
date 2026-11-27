import { useId } from 'react';

const ridges = [
  'M119 -16C175 32 196 57 203 93S173 166 212 211s112 58 151 103',
  'M96 -15C151 28 174 62 177 97s-31 79 7 129 110 54 146 93',
  'M73 -16c45 40 73 83 75 118 2 42-27 77 6 126 30 44 110 65 143 96',
  'M43 -17c49 38 72 85 70 124-2 45-27 78 6 128 23 37 78 65 135 89',
  'M14 -14c47 32 73 79 67 124-6 43-23 78 2 124 21 39 70 71 124 93',
  'M-20 -4c47 25 72 71 66 122-7 52-18 87 5 130 20 35 57 61 95 78',
  'M-29 26c33 29 47 61 42 97-8 59-19 95 9 138 13 21 35 42 65 61',
  'M253 -16c35 47 41 70 29 118-10 38-5 84 23 106 48 38 104 13 149 32 28 12 48 34 63 54',
  'M288 -18c31 52 32 75 18 118-13 40-2 65 21 85 39 34 99 10 149 34 25 12 45 34 58 56',
  'M330 -11c28 42 21 73 6 116-14 39 1 59 20 68 36 18 79 6 129 21 23 7 44 23 63 43',
  'M383 -13c14 43 12 71-1 113-18 56 28 56 68 58 39 2 81 22 105 45',
  'M430 -15c16 43 2 71-8 103-14 48 38 45 56 48 32 6 60 18 76 33',
  'M473 -19c8 34-3 54-6 83-7 52 53 45 90 71',
  'M515 -10c-3 35-27 75 39 101',
];

const water = 'M201 -10c-6 56 51 63 46 111-5 47-31 67 8 103 30 27 79 16 115 22 39 6 80 41 127 60 22 9 40 12 63 14';
const tributary = 'M239 146c22 9 46 32 101 28 63-4 82-42 119-54 35-11 69-7 109-1';
const sediment = 'M325 225c27 22 23 62 47 96M393 234c38-4 44-36 75-44 26-7 56-2 92 2M255 204c-17 17-12 48 4 70 13 18 28 26 40 47';
const lava = 'M-20 240c120-18 136-119 216-112 75 7 99 92 175 81 81-12 81-104 190-111';
const embers = 'M106 176c23 5 67 31 99 76 22 31 57 51 109 65M247 152c13-30 39-37 55-62 21-33 20-61 41-102M385 203c34 0 63 34 84 63 20 28 49 34 93 32';

export function FlowArt() {
  const id = useId();
  return <div className="flow-art" aria-hidden="true">
    <svg viewBox="0 0 540 304" preserveAspectRatio="xMidYMid slice" focusable="false">
      <defs>
        <linearGradient id={`${id}-water`} x2="1" y2="1"><stop stopColor="#425f76" /><stop offset=".55" stopColor="#75adb9" /><stop offset="1" stopColor="#b4d3cb" /></linearGradient>
        <linearGradient id={`${id}-lava`} x2="1" y2="1"><stop stopColor="#778efe" /><stop offset=".45" stopColor="#425fe8" /><stop offset=".7" stopColor="#c17cf8" /><stop offset="1" stopColor="#f68c68" /></linearGradient>
      </defs>
      <g className="flow-water" fill="none" strokeLinecap="round">
        {ridges.map(path => <path key={path} d={path} className="flow-contour" />)}
        <path d={water} stroke="#b0caca" strokeWidth="55" opacity=".45" />
        <path d={tributary} stroke="#b0caca" strokeWidth="29" opacity=".48" />
        <path d={sediment} stroke="#8cb8ba" strokeWidth="9" opacity=".85" />
        <path d={tributary} stroke={`url(#${id}-water)`} strokeWidth="12" />
        <path d={water} stroke={`url(#${id}-water)`} strokeWidth="24" />
        <path d={water} className="flow-trace" stroke="#d6eee5" strokeWidth="1.5" />
        <path d={tributary} className="flow-trace" stroke="#c5e2d8" />
        <path d="M39 202c30 8 52 28 69 47M55 241c20 7 37 21 47 39M451 52c37-3 69 2 103 16" stroke="#ce6049" strokeWidth="2" opacity=".38" />
      </g>
      <g className="flow-lava" fill="none" strokeLinecap="round">
        {ridges.map(path => <path key={path} d={path} className="flow-contour" transform="translate(540 304) rotate(180)" />)}
        <path d={lava} stroke="#2e47b3" strokeWidth="40" opacity=".36" />
        <path d={lava} stroke="#3548b6" strokeWidth="23" opacity=".66" />
        <path d={embers} stroke="#586df1" strokeWidth="9" opacity=".67" />
        <path d={lava} stroke={`url(#${id}-lava)`} strokeWidth="9" />
        <path d={embers} stroke={`url(#${id}-lava)`} strokeWidth="2.5" />
        <path d={lava} className="flow-trace" stroke="#f5c7df" strokeWidth="2" />
      </g>
    </svg>
  </div>;
}
