export function ProductStories() {
  return (
    <section className="landing-product-stories" id="product">
      <div className="landing-container">
        <header className="landing-section-heading">
          <p className="landing-eyebrow">A more useful money review</p>
          <h2>Three questions. One connected picture.</h2>
          <p>
            Pocket Pulse keeps the overview and the evidence together, so a number
            never becomes a dead end.
          </p>
        </header>

        <article className="landing-story">
          <div className="landing-story-copy">
            <span className="landing-story-number">01</span>
            <p className="landing-story-label">Monthly dashboard</p>
            <h3>Where did the money go?</h3>
            <p>See income, total spending, cash flow, and category mix for the month you are reviewing.</p>
          </div>
          <div className="landing-story-visual landing-category-visual" aria-hidden="true">
            <div className="landing-visual-head"><span>Spending by category</span><strong>$2,883</strong></div>
            {[
              ["Housing", "$1,450", "82%"],
              ["Groceries", "$416", "52%"],
              ["Dining", "$238", "34%"],
              ["Transport", "$174", "24%"],
            ].map(([label, amount, width]) => (
              <div className="landing-category-row" key={label}>
                <span>{label}</span><i><b style={{ width }} /></i><strong>{amount}</strong>
              </div>
            ))}
          </div>
        </article>

        <article className="landing-story is-reversed">
          <div className="landing-story-copy">
            <span className="landing-story-number">02</span>
            <p className="landing-story-label">Recurring expenses</p>
            <h3>What keeps charging me?</h3>
            <p>Separate rent, bills, subscriptions, and other recurring expenses from one-time spending—and open the exact matching transactions.</p>
          </div>
          <div className="landing-story-visual landing-recurring-visual" aria-hidden="true">
            <div className="landing-visual-head"><span>Recurring this month</span><strong>$1,603.98</strong></div>
            <div><span><i className="is-housing">H</i>Rent</span><strong>$1,450.00</strong></div>
            <div><span><i className="is-utility">U</i>Home internet</span><strong>$79.99</strong></div>
            <div><span><i className="is-mobile">M</i>Mobile plan</span><strong>$62.00</strong></div>
            <div><span><i className="is-media">S</i>Spotify</span><strong>$11.99</strong></div>
            <span className="landing-visual-action">View 4 transactions →</span>
          </div>
        </article>

        <article className="landing-story">
          <div className="landing-story-copy">
            <span className="landing-story-number">03</span>
            <p className="landing-story-label">Leak Hunter</p>
            <h3>What deserves a closer look?</h3>
            <p>Surface similar recent purchases, active subscriptions, ended charges, and cost changes—with the supporting transaction trail attached.</p>
          </div>
          <div className="landing-story-visual landing-leak-visual" aria-hidden="true">
            <div className="landing-visual-head"><span>Repeated spending</span><em>Priority review</em></div>
            <h4>Coffee Shop</h4>
            <p>Six similar purchases in the recent window.</p>
            <div className="landing-leak-chart">
              {[42, 64, 51, 76, 58, 88].map((height, index) => <i key={index} style={{ height: `${height}%` }} />)}
            </div>
            <div className="landing-leak-total"><span><strong>$46.80</strong> across 6 purchases</span><b>Review transactions →</b></div>
          </div>
        </article>
      </div>
    </section>
  );
}
