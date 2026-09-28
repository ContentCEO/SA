import { Headline } from "@/components/brand/headline";
import { Wordmark } from "@/components/brand/wordmark";
import { siteConfig } from "@/config/site";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col px-5 py-8">
      <header>
        <Wordmark />
      </header>
      <section className="flex flex-1 flex-col justify-center gap-6 py-16">
        <Headline serif="your inbox," heavy="handled." size="xl" />
        <p className="max-w-sm text-lg text-muted-foreground">
          Squared Away is getting set up. Nothing is connected yet, and nothing will be sent without
          your okay.
        </p>
      </section>
      <footer className="text-sm text-muted-foreground">{siteConfig.copyright}</footer>
    </main>
  );
}
