/** App wordmark: "GRAM Hub" over "TON ECOSYSTEM". Plain text, so it is crisp at any size and needs no image request. */
export function Logo() {
  return (
    <div className="min-w-0 leading-none" aria-label="GRAM Hub, TON Ecosystem" role="img">
      <p className="whitespace-nowrap text-[17px] font-extrabold tracking-tight text-content-primary min-[400px]:text-[19px]">GRAM Hub</p>
      <p className="mt-1 whitespace-nowrap text-[9px] font-bold uppercase tracking-[0.08em] text-content-muted min-[400px]:tracking-[0.14em]">TON Ecosystem</p>
    </div>
  )
}
