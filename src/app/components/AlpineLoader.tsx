'use client'
import { useEffect } from 'react'

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return }
    const s = document.createElement('script')
    s.src = src
    s.onload = () => resolve()
    s.onerror = reject
    document.body.appendChild(s)
  })
}

export default function AlpineLoader({ scripts = [] }: { scripts?: string[] }) {
  useEffect(() => {
    (async () => {
      for (const src of scripts) await loadScript(src)
      await loadScript('https://cdn.jsdelivr.net/npm/alpinejs@3.14.9/dist/cdn.min.js')
    })()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return null
}
