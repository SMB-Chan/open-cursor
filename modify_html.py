import re

with open('timetable.html', 'r', encoding='utf-8') as f:
    content = f.read()

# Fix PWA paths
content = content.replace('href="/Rintetsu_ryoubi/manifest.json"', 'href="./manifest.json"')
content = content.replace('href="/Rintetsu_ryoubi/icon.svg"', 'href="./icon.svg"')
content = content.replace("register('/Rintetsu_ryoubi/sw.js', { scope: '/Rintetsu_ryoubi/' })", "register('./sw.js', { scope: './' })")

# Add JR Sanyo block
jr_sanyo_html = """
        <!-- JR山陽本線 -->
        <div class="timetable jr-sanyo">
            <h2>JR山陽本線（上り）<br><small>西阿知駅 → 倉敷駅</small></h2>
            <div class="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th>西阿知駅 発</th>
                            <th>倉敷駅 着</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr><td>05:29</td><td>05:33</td></tr>
                        <tr><td>06:07</td><td>06:11</td></tr>
                        <tr><td>06:26</td><td>06:31</td></tr>
                        <tr><td>06:55</td><td>06:59</td></tr>
                        <tr><td>07:10</td><td>07:14</td></tr>
                        <tr><td>07:26</td><td>07:30</td></tr>
                        <tr><td>07:47</td><td>07:51</td></tr>
                        <tr><td>07:53</td><td>07:57</td></tr>
                        <tr><td>08:03</td><td>08:07</td></tr>
                        <tr><td>08:21</td><td>08:25</td></tr>
                        <tr><td>08:38</td><td>08:42</td></tr>
                        <tr><td>08:54</td><td>08:59</td></tr>
                        <tr><td>09:08</td><td>09:12</td></tr>
                        <tr><td>09:17</td><td>09:22</td></tr>
                        <tr><td>09:43</td><td>09:47</td></tr>
                        <tr><td>10:08</td><td>10:12</td></tr>
                        <tr><td>10:18</td><td>10:22</td></tr>
                        <tr><td>10:40</td><td>10:45</td></tr>
                        <tr><td>11:19</td><td>11:23</td></tr>
                        <tr><td>11:55</td><td>11:59</td></tr>
                        <tr><td>12:10</td><td>12:14</td></tr>
                        <tr><td>12:21</td><td>12:26</td></tr>
                        <tr><td>12:46</td><td>12:50</td></tr>
                        <tr><td>13:06</td><td>13:10</td></tr>
                        <tr><td>13:17</td><td>13:21</td></tr>
                        <tr><td>13:47</td><td>13:51</td></tr>
                        <tr><td>14:09</td><td>14:13</td></tr>
                        <tr><td>15:08</td><td>15:12</td></tr>
                        <tr><td>15:22</td><td>15:26</td></tr>
                        <tr><td>15:48</td><td>15:52</td></tr>
                        <tr><td>16:09</td><td>16:13</td></tr>
                        <tr><td>16:29</td><td>16:33</td></tr>
                        <tr><td>16:43</td><td>16:47</td></tr>
                        <tr><td>17:06</td><td>17:11</td></tr>
                        <tr><td>17:16</td><td>17:21</td></tr>
                        <tr><td>17:34</td><td>17:38</td></tr>
                        <tr><td>17:52</td><td>17:56</td></tr>
                        <tr><td>18:13</td><td>18:17</td></tr>
                        <tr><td>18:35</td><td>18:39</td></tr>
                        <tr><td>18:53</td><td>18:57</td></tr>
                        <tr><td>19:15</td><td>19:19</td></tr>
                        <tr><td>19:30</td><td>19:35</td></tr>
                        <tr><td>19:45</td><td>19:50</td></tr>
                        <tr><td>20:01</td><td>20:05</td></tr>
                        <tr><td>20:12</td><td>20:16</td></tr>
                        <tr><td>20:44</td><td>20:48</td></tr>
                        <tr><td>21:08</td><td>21:12</td></tr>
                        <tr><td>21:25</td><td>21:29</td></tr>
                        <tr><td>21:44</td><td>21:48</td></tr>
                        <tr><td>22:13</td><td>22:17</td></tr>
                        <tr><td>22:36</td><td>22:40</td></tr>
                        <tr><td>23:03</td><td>23:07</td></tr>
                        <tr><td>23:47</td><td>23:51</td></tr>
                    </tbody>
                </table>
            </div>
            <div class="note">
                ※JR山陽本線の時刻はNAVITIMEのスクリーンショットに基づいています。<br>
                ※所要時間は約4〜5分です。
            </div>
        </div>
"""

# Insert right after the bus div block
content = content.replace('<!-- 両備バス -->', '<!-- 両備バス -->') # dummy check
parts = content.split('</div>\n    </div>\n\n    <script>')
new_content = parts[0] + '\n' + jr_sanyo_html + '    </div>\n\n    <script>' + parts[1]

# Update Titles
new_content = new_content.replace('倉敷駅周辺〜西富井・穴場神社前 ダイヤ比較表', '倉敷駅周辺〜西富井・穴場神社前・西阿知 ダイヤ比較表')
new_content = new_content.replace('倉敷駅周辺 〜 西富井・穴場神社前 ダイヤ比較表', '倉敷駅周辺 〜 西富井・穴場神社前・西阿知 ダイヤ比較表')

# Update CSS
css_jr = '\n        .jr-sanyo h2 { color: #8e44ad; border-bottom-color: #8e44ad; }\n        '
new_content = new_content.replace('.bus h2 { color: #27ae60; border-bottom-color: #27ae60; }', '.bus h2 { color: #27ae60; border-bottom-color: #27ae60; }' + css_jr)

# Update Javascript
js_old = """            const nextTrain = getNextRide('.railway table', inputTimeMinutes);
            const nextBus = getNextRide('.bus table', inputTimeMinutes);

            const scrollRowToCenter = (row) => {
                const wrap = row.closest('.table-wrap');
                if (wrap) {
                    wrap.scrollTo({
                        top: row.offsetTop - (wrap.clientHeight / 2) + (row.clientHeight / 2),
                        behavior: 'smooth'
                    });
                }
            };

            if (nextTrain) scrollRowToCenter(nextTrain.element);
            if (nextBus) scrollRowToCenter(nextBus.element);

            const resultBox = document.getElementById('resultBox');

            if (!nextTrain && !nextBus) {
                resultBox.innerHTML = '<span style="color: red;">本日の運行は終了しました。</span>';
                return;
            }

            let recommendation = '';

            if (nextTrain && nextBus) {
                if (nextTrain.arrivalMins < nextBus.arrivalMins) {
                    recommendation = `おすすめ: <span style="color: #2980b9;">水島臨海鉄道</span> (${nextTrain.departure}発 → ${nextTrain.arrival}着)`;
                    nextTrain.element.style.backgroundColor = '#d6eaf8';
                } else if (nextBus.arrivalMins < nextTrain.arrivalMins) {
                    recommendation = `おすすめ: <span style="color: #27ae60;">両備バス</span> (${nextBus.departure}発 → ${nextBus.arrival}着)`;
                    nextBus.element.style.backgroundColor = '#d5f5e3';
                } else {
                    // 同時到着なら出発が遅い方（待ち時間が短い方）
                    if (nextTrain.departureMins > nextBus.departureMins) {
                        recommendation = `おすすめ: <span style="color: #2980b9;">水島臨海鉄道</span> (${nextTrain.departure}発 → ${nextTrain.arrival}着)`;
                        nextTrain.element.style.backgroundColor = '#d6eaf8';
                    } else if (nextBus.departureMins > nextTrain.departureMins) {
                         recommendation = `おすすめ: <span style="color: #27ae60;">両備バス</span> (${nextBus.departure}発 → ${nextBus.arrival}着)`;
                         nextBus.element.style.backgroundColor = '#d5f5e3';
                    } else {
                        recommendation = `おすすめ: どちらでも同じ時刻に出発・到着します（鉄道: ${nextTrain.arrival}着 / バス: ${nextBus.arrival}着）`;
                        nextTrain.element.style.backgroundColor = '#d6eaf8';
                        nextBus.element.style.backgroundColor = '#d5f5e3';
                    }
                }
            } else if (nextTrain) {
                recommendation = `バスは終了しています。おすすめ: <span style="color: #2980b9;">水島臨海鉄道</span> (${nextTrain.departure}発 → ${nextTrain.arrival}着)`;
                nextTrain.element.style.backgroundColor = '#d6eaf8';
            } else if (nextBus) {
                recommendation = `鉄道は終了しています。おすすめ: <span style="color: #27ae60;">両備バス</span> (${nextBus.departure}発 → ${nextBus.arrival}着)`;
                nextBus.element.style.backgroundColor = '#d5f5e3';
            }

            resultBox.innerHTML = recommendation;"""

js_new = """            const nextTrain = getNextRide('.railway table', inputTimeMinutes);
            const nextBus = getNextRide('.bus table', inputTimeMinutes);
            const nextJR = getNextRide('.jr-sanyo table', inputTimeMinutes);

            const scrollRowToCenter = (row) => {
                const wrap = row.closest('.table-wrap');
                if (wrap) {
                    wrap.scrollTo({
                        top: row.offsetTop - (wrap.clientHeight / 2) + (row.clientHeight / 2),
                        behavior: 'smooth'
                    });
                }
            };

            if (nextTrain) scrollRowToCenter(nextTrain.element);
            if (nextBus) scrollRowToCenter(nextBus.element);
            if (nextJR) scrollRowToCenter(nextJR.element);

            const resultBox = document.getElementById('resultBox');

            const options = [];
            if (nextTrain) options.push({ type: 'train', name: '水島臨海鉄道', color: '#2980b9', bgColor: '#d6eaf8', route: `${nextTrain.departure}発 → ${nextTrain.arrival}着`, data: nextTrain });
            if (nextBus) options.push({ type: 'bus', name: '両備バス', color: '#27ae60', bgColor: '#d5f5e3', route: `${nextBus.departure}発 → ${nextBus.arrival}着`, data: nextBus });
            if (nextJR) options.push({ type: 'jr', name: 'JR山陽本線', color: '#8e44ad', bgColor: '#ebdef0', route: `${nextJR.departure}発 → ${nextJR.arrival}着`, data: nextJR });

            if (options.length === 0) {
                resultBox.innerHTML = '<span style="color: red;">本日の運行は終了しました。</span>';
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

            let recommendation = '';
            if (tied.length === 1) {
                recommendation = `おすすめ: <span style="color: ${best.color};">${best.name}</span> (${best.route})`;
                best.data.element.style.backgroundColor = best.bgColor;
            } else {
                recommendation = `おすすめ: どちらでも同じ時刻に出発・到着します<br>`;
                recommendation += tied.map(opt => `<span style="color: ${opt.color};">${opt.name}</span> (${opt.route})`).join(' / ');
                tied.forEach(opt => opt.data.element.style.backgroundColor = opt.bgColor);
            }

            resultBox.innerHTML = recommendation;"""

new_content = new_content.replace(js_old, js_new)

with open('timetable.html', 'w', encoding='utf-8') as f:
    f.write(new_content)

print("done")
