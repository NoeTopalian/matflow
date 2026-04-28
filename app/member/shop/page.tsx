"use client";

import { useState, useEffect, useCallback } from "react";
import { ShoppingCart, Plus, Minus, X, ChevronDown, CheckCircle2, Loader2, ShoppingBag, Apple } from "lucide-react";

interface Product {
  id: string;
  name: string;
  price: number;
  category: string;
  inStock: boolean;
  symbol: string;
  description: string;
}

interface CartItem extends Product {
  quantity: number;
}

const CATEGORY_LABELS: Record<string, string> = {
  all: "All",
  clothing: "Clothing",
  food: "Food",
  drink: "Drinks",
  equipment: "Equipment",
  other: "Other",
};

function getPrimary() {
  if (typeof window === "undefined") return "#3b82f6";
  try {
    const s = JSON.parse(localStorage.getItem("gym-settings") ?? "{}");
    return s.primaryColor ?? "#3b82f6";
  } catch { return "#3b82f6"; }
}

function hex(h: string, a: number) {
  const n = parseInt(h.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

const PAY_AT_DESK = !process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;

export default function MemberShopPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [category, setCategory] = useState("all");
  const [cartOpen, setCartOpen] = useState(false);
  const [checkingOut, setCheckingOut] = useState(false);
  const [orderSuccess, setOrderSuccess] = useState<{ ref: string; total: number } | null>(null);
  const [primary, setPrimary] = useState("#3b82f6");
  const [loadError, setLoadError] = useState<string | null>(null);

  function loadPageData() {
    setLoadError(null);
    fetch("/api/member/products")
      .then((r) => r.json())
      .then(setProducts)
      .catch((e) => setLoadError(e instanceof Error ? e.message : "Couldn't load — tap to retry"));
  }

  useEffect(() => {
    setPrimary(getPrimary());
    loadPageData();

    // Check for success redirect from Stripe
    const url = new URL(window.location.href);
    if (url.searchParams.get("success")) {
      setOrderSuccess({ ref: "Stripe payment", total: 0 });
      window.history.replaceState({}, "", "/member/shop");
    }
  }, []);

  const cartTotal = cart.reduce((s, i) => s + i.price * i.quantity, 0);
  const cartCount = cart.reduce((s, i) => s + i.quantity, 0);

  const addToCart = useCallback((product: Product) => {
    setCart((prev) => {
      const existing = prev.find((i) => i.id === product.id);
      if (existing) {
        return prev.map((i) => i.id === product.id ? { ...i, quantity: i.quantity + 1 } : i);
      }
      return [...prev, { ...product, quantity: 1 }];
    });
  }, []);

  const updateQty = useCallback((id: string, delta: number) => {
    setCart((prev) =>
      prev.map((i) => i.id === id ? { ...i, quantity: Math.max(0, i.quantity + delta) } : i)
        .filter((i) => i.quantity > 0)
    );
  }, []);

  const removeFromCart = useCallback((id: string) => {
    setCart((prev) => prev.filter((i) => i.id !== id));
  }, []);

  async function checkout() {
    if (!cart.length) return;
    setCheckingOut(true);
    try {
      const res = await fetch("/api/member/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: cart.map((i) => ({ id: i.id, name: i.name, price: i.price, quantity: i.quantity })),
          successUrl: `${window.location.origin}/member/shop?success=1`,
          cancelUrl: `${window.location.origin}/member/shop`,
        }),
      });
      const data = await res.json();
      if (data.mode === "stripe" && data.url) {
        window.location.href = data.url;
      } else if (data.mode === "pay_at_desk") {
        setOrderSuccess({ ref: data.orderRef, total: data.total });
        setCart([]);
        setCartOpen(false);
      } else {
        alert(data.error ?? "Checkout failed");
      }
    } catch {
      alert("Could not complete checkout. Please try again.");
    } finally {
      setCheckingOut(false);
    }
  }

  const categories = ["all", ...Array.from(new Set(products.map((p) => p.category)))];
  const filtered = category === "all" ? products : products.filter((p) => p.category === category);

  if (orderSuccess) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[70vh] px-6 text-center">
        <div className="w-20 h-20 rounded-full flex items-center justify-center mb-5" style={{ background: hex(primary, 0.15) }}>
          <CheckCircle2 className="w-10 h-10" style={{ color: primary }} />
        </div>
        <h2 className="text-white text-2xl font-bold mb-2">Order Placed!</h2>
        <p className="text-gray-400 text-sm mb-1">Reference: <span className="text-white font-semibold">{orderSuccess.ref}</span></p>
        {orderSuccess.total > 0 && (
          <p className="text-gray-400 text-sm mb-1">Total: <span className="text-white font-semibold">£{orderSuccess.total.toFixed(2)}</span></p>
        )}
        <p className="text-gray-500 text-sm mt-2 mb-8">Please show this to staff at the front desk to collect your items.</p>
        <button
          onClick={() => setOrderSuccess(null)}
          className="px-6 py-3 rounded-2xl text-white font-semibold text-sm"
          style={{ background: primary }}
        >
          Continue Shopping
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      {/* ── Header ── */}
      <div className="px-4 pt-5 pb-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-white text-2xl font-bold">Club Store</h1>
            <p className="text-gray-500 text-sm mt-0.5">Gear up for training</p>
          </div>
          {/* Cart button */}
          <button
            onClick={() => setCartOpen(true)}
            className="relative w-12 h-12 rounded-2xl flex items-center justify-center transition-transform active:scale-90"
            style={{ background: cartCount > 0 ? hex(primary, 0.15) : "rgba(255,255,255,0.07)" }}
            aria-label="Open cart"
          >
            <ShoppingCart className="w-5 h-5" style={{ color: cartCount > 0 ? primary : "rgba(255,255,255,0.5)" }} />
            {cartCount > 0 && (
              <span
                className="absolute -top-1 -right-1 min-w-[18px] h-[18px] rounded-full flex items-center justify-center text-[10px] font-bold text-white px-1"
                style={{ background: primary }}
              >
                {cartCount}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Load error banner */}
      {loadError && (
        <div className="mx-4 mb-4 px-4 py-3 rounded-2xl flex items-center justify-between gap-3" style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)" }}>
          <p className="text-red-400 text-sm flex-1">{loadError}</p>
          <button
            onClick={loadPageData}
            className="text-xs font-semibold px-3 py-1.5 rounded-xl shrink-0"
            style={{ background: "rgba(239,68,68,0.15)", color: "#f87171" }}
          >
            Retry
          </button>
        </div>
      )}

      {/* ── Category filter ── */}
      <div className="px-4 mb-4">
        <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setCategory(cat)}
              className="shrink-0 px-4 py-2 rounded-full text-xs font-semibold transition-all"
              style={{
                background: category === cat ? primary : "rgba(255,255,255,0.07)",
                color: category === cat ? "#fff" : "rgba(255,255,255,0.5)",
              }}
            >
              {CATEGORY_LABELS[cat] ?? cat}
            </button>
          ))}
        </div>
      </div>

      {/* ── Product grid ── */}
      <div className="px-4 pb-6">
        {filtered.length === 0 ? (
          <div className="text-center py-16">
            <ShoppingBag className="w-12 h-12 text-gray-700 mx-auto mb-3" />
            <p className="text-gray-600 text-sm">No items in this category</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {filtered.map((product) => {
              const inCart = cart.find((i) => i.id === product.id);
              return (
                <div
                  key={product.id}
                  className="rounded-2xl overflow-hidden flex flex-col"
                  style={{
                    background: "var(--member-surface, rgba(255,255,255,0.04))",
                    border: `1px solid ${inCart ? hex(primary, 0.4) : "var(--member-border, rgba(255,255,255,0.07))"}`,
                    opacity: product.inStock ? 1 : 0.5,
                  }}
                >
                  {/* Symbol area */}
                  <div
                    className="flex items-center justify-center text-4xl"
                    style={{ height: 90, background: "var(--member-surface, rgba(255,255,255,0.03))" }}
                  >
                    {product.symbol}
                  </div>

                  {/* Info */}
                  <div className="p-3 flex flex-col flex-1">
                    <p className="text-white text-sm font-semibold leading-tight">{product.name}</p>
                    <p className="text-gray-600 text-[10px] mt-0.5 leading-tight flex-1">{product.description}</p>

                    {!product.inStock && (
                      <span className="text-[10px] text-red-400 font-medium mt-1">Out of stock</span>
                    )}

                    <div className="flex items-center justify-between mt-2.5">
                      <span className="text-white font-bold text-base">£{product.price}</span>
                      {product.inStock && (
                        inCart ? (
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => updateQty(product.id, -1)}
                              className="w-7 h-7 rounded-lg flex items-center justify-center"
                              style={{ background: "rgba(255,255,255,0.1)" }}
                            >
                              <Minus className="w-3 h-3 text-white" />
                            </button>
                            <span className="text-white text-sm font-bold w-4 text-center">{inCart.quantity}</span>
                            <button
                              onClick={() => updateQty(product.id, 1)}
                              className="w-7 h-7 rounded-lg flex items-center justify-center"
                              style={{ background: primary }}
                            >
                              <Plus className="w-3 h-3 text-white" />
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => addToCart(product)}
                            className="w-8 h-8 rounded-xl flex items-center justify-center transition-transform active:scale-90"
                            style={{ background: primary }}
                          >
                            <Plus className="w-4 h-4 text-white" />
                          </button>
                        )
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Cart drawer ── */}
      {cartOpen && (
        <>
          <div className="fixed inset-0 bg-black/60 z-40" onClick={() => setCartOpen(false)} />
          <div
            className="fixed bottom-0 left-0 right-0 z-50 rounded-t-3xl flex flex-col"
            style={{
              background: "#0e1013",
              border: "1px solid rgba(255,255,255,0.08)",
              borderBottom: "none",
              maxHeight: "85vh",
            }}
          >
            {/* Handle */}
            <div className="flex justify-center pt-3 pb-1">
              <div className="w-10 h-1 rounded-full bg-white/20" />
            </div>

            <div className="flex items-center justify-between px-5 py-3">
              <h2 className="text-white font-bold text-lg">Your Cart</h2>
              <button onClick={() => setCartOpen(false)} className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: "rgba(255,255,255,0.08)" }}>
                <X className="w-4 h-4 text-gray-400" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 pb-4">
              {cart.length === 0 ? (
                <div className="text-center py-12">
                  <ShoppingCart className="w-10 h-10 text-gray-700 mx-auto mb-3" />
                  <p className="text-gray-600 text-sm">Your cart is empty</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {cart.map((item) => (
                    <div key={item.id} className="flex items-center gap-3">
                      <span className="text-2xl shrink-0">{item.symbol}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-white text-sm font-semibold truncate">{item.name}</p>
                        <p className="text-gray-500 text-xs">£{item.price} each</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button onClick={() => updateQty(item.id, -1)} className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: "rgba(255,255,255,0.08)" }}>
                          <Minus className="w-3 h-3 text-white" />
                        </button>
                        <span className="text-white text-sm font-bold w-4 text-center">{item.quantity}</span>
                        <button onClick={() => updateQty(item.id, 1)} className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: "rgba(255,255,255,0.08)" }}>
                          <Plus className="w-3 h-3 text-white" />
                        </button>
                        <button onClick={() => removeFromCart(item.id)} className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-600 hover:text-red-400 ml-1">
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Checkout section */}
            {cart.length > 0 && (
              <div className="px-5 pb-8 pt-3 border-t border-white/5 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-gray-400 text-sm">Total</span>
                  <span className="text-white font-bold text-xl">£{cartTotal.toFixed(2)}</span>
                </div>

                <button
                  onClick={checkout}
                  disabled={checkingOut}
                  className="w-full py-4 rounded-2xl text-white font-bold text-base flex items-center justify-center gap-2 disabled:opacity-60 transition-transform active:scale-[0.98]"
                  style={{ background: primary }}
                >
                  {checkingOut ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : PAY_AT_DESK ? (
                    <>Place Order · £{cartTotal.toFixed(2)}</>
                  ) : (
                    <>
                      <Apple className="w-5 h-5" />
                      Pay · £{cartTotal.toFixed(2)}
                    </>
                  )}
                </button>

                {!PAY_AT_DESK && (
                  <p className="text-gray-600 text-[10px] text-center">
                    Powered by Stripe · Apple Pay &amp; card supported
                  </p>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
