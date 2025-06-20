# generate_icons.py
from PIL import Image
import cairosvg
import io

# SVG content (paste the SVG code here)
svg_content = '''
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <!-- Background Circle -->
  <circle cx="256" cy="256" r="240" fill="#3b82f6" stroke="#1e40af" stroke-width="8"/>

  <!-- Baby Monitor Base -->
  <rect x="180" y="280" width="152" height="120" rx="20" fill="#ffffff" stroke="#e5e7eb" stroke-width="4"/>

  <!-- Speaker Grille -->
  <circle cx="256" cy="320" r="35" fill="#f3f4f6" stroke="#d1d5db" stroke-width="2"/>
  <circle cx="256" cy="320" r="25" fill="#9ca3af"/>
  <circle cx="256" cy="320" r="15" fill="#6b7280"/>
  <circle cx="256" cy="320" r="8" fill="#374151"/>

  <!-- Status LED -->
  <circle cx="280" cy="365" r="6" fill="#10b981"/>
  <circle cx="280" cy="365" r="3" fill="#34d399"/>

  <!-- Power Button -->
  <circle cx="232" cy="365" r="8" fill="#ef4444" stroke="#dc2626" stroke-width="2"/>

  <!-- Baby Head -->
  <circle cx="256" cy="180" r="60" fill="#fde68a"/>

  <!-- Baby Hair -->
  <path d="M 210 140 Q 256 120 302 140 Q 295 110 256 110 Q 217 110 210 140" fill="#92400e"/>

  <!-- Baby Eyes -->
  <circle cx="235" cy="170" r="8" fill="#1f2937"/>
  <circle cx="277" cy="170" r="8" fill="#1f2937"/>
  <circle cx="237" cy="168" r="3" fill="#ffffff"/>
  <circle cx="279" cy="168" r="3" fill="#ffffff"/>

  <!-- Baby Nose -->
  <ellipse cx="256" cy="185" rx="4" ry="6" fill="#f59e0b"/>

  <!-- Baby Mouth -->
  <path d="M 245 200 Q 256 210 267 200" stroke="#dc2626" stroke-width="3" fill="none" stroke-linecap="round"/>

  <!-- Sound Waves -->
  <path d="M 320 180 Q 340 180 340 200 Q 340 220 320 220" stroke="#10b981" stroke-width="6" fill="none" stroke-linecap="round" opacity="0.8"/>
  <path d="M 335 170 Q 365 170 365 200 Q 365 230 335 230" stroke="#10b981" stroke-width="4" fill="none" stroke-linecap="round" opacity="0.6"/>
  <path d="M 350 160 Q 390 160 390 200 Q 390 240 350 240" stroke="#10b981" stroke-width="3" fill="none" stroke-linecap="round" opacity="0.4"/>

  <!-- WiFi/Connection Symbol -->
  <path d="M 180 120 Q 200 100 220 120" stroke="#ffffff" stroke-width="4" fill="none" stroke-linecap="round"/>
  <path d="M 170 130 Q 200 90 230 130" stroke="#ffffff" stroke-width="3" fill="none" stroke-linecap="round" opacity="0.7"/>
  <path d="M 160 140 Q 200 80 240 140" stroke="#ffffff" stroke-width="2" fill="none" stroke-linecap="round" opacity="0.5"/>
  <circle cx="200" cy="135" r="4" fill="#ffffff"/>

  <!-- Mobile Device Indicator -->
  <rect x="360" y="320" width="40" height="65" rx="8" fill="#1f2937" stroke="#374151" stroke-width="2"/>
  <rect x="365" y="330" width="30" height="40" fill="#3b82f6"/>
  <circle cx="380" cy="375" r="3" fill="#6b7280"/>

  <!-- Heart (Love/Care Symbol) -->
  <path d="M 140 240 C 130 220, 100 220, 100 250 C 100 270, 140 300, 140 300 C 140 300, 180 270, 180 250 C 180 220, 150 220, 140 240 Z" fill="#ef4444" opacity="0.8"/>
</svg>
'''

# Required icon sizes
sizes = [72, 96, 128, 144, 152, 192, 384, 512]

def svg_to_png(svg_content, size):
    # Convert SVG to PNG using cairosvg
    png_data = cairosvg.svg2png(
        bytestring=svg_content.encode('utf-8'),
        output_width=size,
        output_height=size
    )
    return Image.open(io.BytesIO(png_data))

# Generate all icon sizes
for size in sizes:
    try:
        img = svg_to_png(svg_content, size)
        img.save(f'public/icons/icon-{size}x{size}.png')
        print(f"✅ Generated icon-{size}x{size}.png")
    except Exception as e:
        print(f"❌ Error generating {size}x{size}: {e}")

print("🎉 All icons generated!")
