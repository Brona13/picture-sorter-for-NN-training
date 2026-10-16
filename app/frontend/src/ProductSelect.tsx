/** The product picker: "All" or one of the camera's products. It scopes the ROI lists of the product-aware pages. */
export default function ProductSelect({ products, value, onChange }: { products: string[]; value: string; onChange: (product: string) => void }) {
  if (products.length === 0) return null;
  return (
    <label>
      Product
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All</option>
        {products.map((p) => (
          <option key={p}>{p}</option>
        ))}
      </select>
    </label>
  );
}
