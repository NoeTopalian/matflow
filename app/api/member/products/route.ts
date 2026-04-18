import { NextResponse } from "next/server";

// In a real implementation this reads from the DB products table (Phase 2).
// For now returns hardcoded demo products matching what the admin store shows.
// When Stripe is connected, products will have stripePriceId fields.

export async function GET() {
  const products = [
    { id: "1", name: "Club T-Shirt",    price: 25,  category: "clothing",  inStock: true,  symbol: "👕", description: "100% cotton club T-shirt with embroidered logo" },
    { id: "2", name: "Rashguard",       price: 40,  category: "clothing",  inStock: true,  symbol: "🥋", description: "Compression rashguard, short sleeve" },
    { id: "3", name: "Protein Shake",   price: 4,   category: "drink",     inStock: true,  symbol: "🥤", description: "Post-training protein shake — vanilla or chocolate" },
    { id: "4", name: "Energy Bar",      price: 2,   category: "food",      inStock: false, symbol: "🍫", description: "High protein energy bar" },
    { id: "5", name: "Mouth Guard",     price: 12,  category: "equipment", inStock: true,  symbol: "🦷", description: "Boil-and-bite mouth guard" },
    { id: "6", name: "Club Hoodie",     price: 45,  category: "clothing",  inStock: true,  symbol: "🧥", description: "Premium club hoodie with back print" },
    { id: "7", name: "Sports Tape",     price: 5,   category: "equipment", inStock: true,  symbol: "🏥", description: "Athletic zinc oxide tape, 2.5cm" },
    { id: "8", name: "Water Bottle",    price: 15,  category: "equipment", inStock: true,  symbol: "💧", description: "1L stainless steel club water bottle" },
  ];

  return NextResponse.json(products);
}
