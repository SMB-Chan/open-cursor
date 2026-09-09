import re

with open('timetable.html', 'r', encoding='utf-8') as f:
    content = f.read()

# Update label
content = content.replace(
    '<label for="timeInput">現在時刻または出発予定時刻:</label>',
    '<label for="timeInput">西阿知駅の出発予定時刻:</label>'
)

# Replace Javascript logic
js_old_pattern = r"const nextTrain = getNextRide\('\.railway table', inputTimeMinutes\);.*?resultBox\.innerHTML = recommendation;"

js_new = """const nextJR = getNextRide('.jr-sanyo table', inputTimeMinutes);

            const scrollRowToCenter = (row) => {
                const wrap = row.closest('.table-wrap');
                if (wrap) {
                    wrap.scrollTo({
                        top: row.offsetTop - (wrap.clientHeight / 2) + (row.clientHeight / 2),
                        behavior: 'smooth'
                    });
                }
            };

            const resultBox = document.getElementById('resultBox');

            if (!nextJR) {
                resultBox.innerHTML = '<span style="color: red;">本日のJR線の運行は終了しました。</span>';
                return;
            }

            scrollRowToCenter(nextJR.element);
            
            // 倉敷での乗り換え時間を考慮（5分とする）
            const TRANSFER_TIME = 5;
            const kurashikiDepMins = nextJR.arrivalMins + TRANSFER_TIME;

            const nextTrain = getNextRide('.railway table', kurashikiDepMins);
            const nextBus = getNextRide('.bus table', kurashikiDepMins);

            if (nextTrain) scrollRowToCenter(nextTrain.element);
            if (nextBus) scrollRowToCenter(nextBus.element);

            const options = [];
            if (nextTrain) options.push({ type: 'train', name: '水島臨海鉄道 (西富井行)', color: '#2980b9', bgColor: '#d6eaf8', route: `${nextTrain.departure}発 → ${nextTrain.arrival}着`, data: nextTrain });
            if (nextBus) options.push({ type: 'bus', name: '両備バス (穴場神社前行)', color: '#27ae60', bgColor: '#d5f5e3', route: `${nextBus.departure}発 → ${nextBus.arrival}着`, data: nextBus });

            if (options.length === 0) {
                resultBox.innerHTML = `<span style="color: #8e44ad;">JR (${nextJR.departure}発→${nextJR.arrival}着)</span> に乗車できますが、倉敷からの接続便は終了しています。`;
                nextJR.element.style.backgroundColor = '#ebdef0';
                return;
            }

            options.sort((a, b) => {
                if (a.data.arrivalMins !== b.data.arrivalMins) {
                    return a.data.arrivalMins - b.data.arrivalMins;
                }
                return b.data.departureMins - a.data.departureMins;
            });

            const best = options[0];
            const tied = options.filter(opt => opt.data.arrivalMins === best.data.arrivalMins && opt.data.departureMins === best.data.departureMins);

            let recommendation = `JR: ${nextJR.departure}発 → 倉敷 ${nextJR.arrival}着<br>`;
            if (tied.length === 1) {
                recommendation += `おすすめ: <span style="color: ${best.color};">${best.name}</span> (${best.route})`;
                best.data.element.style.backgroundColor = best.bgColor;
                nextJR.element.style.backgroundColor = '#ebdef0';
            } else {
                recommendation += `おすすめ: 倉敷からどちらでも同じ時刻に到着します<br>`;
                recommendation += tied.map(opt => `<span style="color: ${opt.color};">${opt.name}</span> (${opt.route})`).join(' / ');
                tied.forEach(opt => opt.data.element.style.backgroundColor = opt.bgColor);
                nextJR.element.style.backgroundColor = '#ebdef0';
            }

            resultBox.innerHTML = recommendation;"""

content = re.sub(js_old_pattern, js_new.replace('\\', '\\\\'), content, flags=re.DOTALL)

with open('timetable.html', 'w', encoding='utf-8') as f:
    f.write(content)

print("HTML Updated.")
