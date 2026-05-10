import { TitleBarDragRegion } from './components/TitleBarDragRegion'
import { MainPage } from './components/MainPage'

function App(): React.JSX.Element {
  return (
    <main className="app pt-9">
      <TitleBarDragRegion />
      <MainPage />
    </main>
  )
}

export default App
